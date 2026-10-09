import {
  COMPRESSION_METHOD_STORE,
  COMPRESSION_METHOD_DEFLATE,
  FLAG_ENCRYPTED,
  LOCAL_FILE_HEADER_SIZE,
  LOCAL_FILE_HEADER_SIGNATURE,
} from "./constants.js";
import type {
  CdEntryInfo,
  RandomAccessSource,
  ReadableOptions,
  MacArchiveHandler,
} from "./types.js";
import { readFields, dosDateTimeToDate } from "./utils.js";
import { LFH_FIELDS } from "./zip-records.js";
import { DecompressionFailed } from "./errors.js";
import {
  createDeflateRawDecompressionStream,
  MAX_DECOMPRESSOR_WRITE,
} from "#deflate-raw";

const QUEUING_STRATEGY = new ByteLengthQueuingStrategy({
  highWaterMark: 65536,
});

interface EntryContext {
  source: RandomAccessSource;
  centralDirectoryOffset: number;
  crc32: (data: Uint8Array, value?: number) => number;
  validateCrc32: boolean;
  validateEntrySizes: boolean;
  macArchiveHandler: MacArchiveHandler | null;
}

export class ZipEntry {
  readonly #info: CdEntryInfo;
  readonly #ctx: EntryContext;
  readonly #lastModified: Date;
  readonly #isDirectory: boolean;
  readonly #isCompressed: boolean;
  readonly #isEncrypted: boolean;

  constructor(info: CdEntryInfo, ctx: EntryContext) {
    this.#info = info;
    this.#ctx = ctx;
    this.#lastModified = dosDateTimeToDate(info.lastModDate, info.lastModTime);
    this.#isDirectory = info.name.endsWith("/");
    this.#isCompressed = info.compressionMethod !== COMPRESSION_METHOD_STORE;
    this.#isEncrypted = (info.generalPurposeBitFlag & FLAG_ENCRYPTED) !== 0;
  }

  get name(): string {
    return this.#info.name;
  }
  get comment(): string {
    return this.#info.comment;
  }
  get compressedSize(): number {
    return this.#info.compressedSize;
  }
  get uncompressedSize(): number {
    return this.#info.uncompressedSize;
  }
  get crc32(): number {
    return this.#info.crc32;
  }
  get compressionMethod(): number {
    return this.#info.compressionMethod;
  }
  get lastModified(): Date {
    return new Date(this.#lastModified.getTime());
  }
  get isDirectory(): boolean {
    return this.#isDirectory;
  }
  get isCompressed(): boolean {
    return this.#isCompressed;
  }
  get isEncrypted(): boolean {
    return this.#isEncrypted;
  }
  get zip64(): boolean {
    return this.#info.isZip64;
  }
  get externalAttributes(): number {
    return this.#info.externalFileAttributes;
  }
  get versionMadeBy(): number {
    return this.#info.versionMadeBy;
  }
  get fileHeaderOffset(): number {
    return this.#info.fileHeaderOffset;
  }
  get generalPurposeBitFlag(): number {
    return this.#info.generalPurposeBitFlag;
  }
  get extraFields(): ReadonlyArray<{
    id: number;
    data: Uint8Array<ArrayBuffer>;
  }> {
    return this.#info.extraFields.map((f) => ({
      id: f.id,
      data: f.data.slice(),
    }));
  }

  /**
   * Get a ReadableStream of the entry's data.
   * By default, decompresses deflated entries and validates CRC32.
   * Reads the Local File Header in start() to resolve the data offset
   * before the first pull. Uses desiredSize for backpressure-aware chunking.
   */
  readable(options?: ReadableOptions): ReadableStream<Uint8Array<ArrayBuffer>> {
    const decompress = this.#isCompressed && !options?.rawEntry;
    const validateCrc32 = !(options?.skipCrc32 ?? !this.#ctx.validateCrc32);

    if (this.#isEncrypted) {
      throw new Error("Decryption is not supported");
    }

    if (
      decompress &&
      this.#info.compressionMethod !== COMPRESSION_METHOD_DEFLATE
    ) {
      throw new Error(
        `Unsupported compression method ${this.#info.compressionMethod}`,
      );
    }

    const ctx = this.#ctx;
    const info = this.#info;
    const fileHeaderOffset = info.fileHeaderOffset;
    const compressedSize = info.compressedSize;
    let fileDataOffset = 0;
    let bytesRead = 0;

    // Errors raised before decompression reach the decompressor as an abort
    // and come back out unchanged; anything else is the decompressor's own
    let upstreamError: { reason: unknown } | undefined;
    const recordUpstreamError = (error: unknown): never => {
      upstreamError = { reason: error };
      throw error;
    };

    const rawStream = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        start: () => readLocalFileHeader().catch(recordUpstreamError),
        pull: (controller) =>
          readFileData(controller).catch(recordUpstreamError),
      },
      QUEUING_STRATEGY,
    );

    async function readLocalFileHeader(): Promise<void> {
      const lfhData = await ctx.source.read(
        fileHeaderOffset,
        LOCAL_FILE_HEADER_SIZE,
      );
      const lfhView = new DataView(
        lfhData.buffer,
        lfhData.byteOffset,
        lfhData.byteLength,
      );

      const {
        signature,
        localCrc32,
        localCompressedSize,
        localUncompressedSize,
        filenameLength,
        extraFieldsLength,
      } = readFields(lfhView, LFH_FIELDS);

      if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
        throw new Error("Invalid Local File Header signature");
      }

      fileDataOffset =
        fileHeaderOffset +
        LOCAL_FILE_HEADER_SIZE +
        filenameLength +
        extraFieldsLength;

      // Mac archive LFH validation
      const mac = ctx.macArchiveHandler;
      if (mac && (mac.isMacArchive || mac.isMaybeMacArchive)) {
        mac.validateLocalFileHeader(
          info,
          localCrc32,
          localCompressedSize,
          localUncompressedSize,
          filenameLength,
          extraFieldsLength,
        );
      }

      if (
        compressedSize !== 0 &&
        fileDataOffset + compressedSize > ctx.centralDirectoryOffset
      ) {
        throw new Error(
          `File data overflows file bounds: ${fileDataOffset} + ${compressedSize} > ${ctx.centralDirectoryOffset}`,
        );
      }
    }

    async function readFileData(
      controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>,
    ): Promise<void> {
      if (bytesRead >= compressedSize) {
        controller.close();
        return;
      }

      const remaining = compressedSize - bytesRead;
      const desired = Math.max(controller.desiredSize ?? 65536, 16384);
      const chunkSize = Math.min(remaining, desired);
      const chunk = await ctx.source.read(
        fileDataOffset + bytesRead,
        chunkSize,
      );
      bytesRead += chunk.byteLength;
      if (decompress && chunk.byteLength > MAX_DECOMPRESSOR_WRITE) {
        for (let i = 0; i < chunk.byteLength; i += MAX_DECOMPRESSOR_WRITE) {
          controller.enqueue(chunk.subarray(i, i + MAX_DECOMPRESSOR_WRITE));
        }
      } else {
        controller.enqueue(chunk);
      }

      if (bytesRead >= compressedSize) {
        controller.close();
      }
    }

    let stream: ReadableStream<Uint8Array<ArrayBuffer>> = rawStream;

    if (decompress) {
      stream = stream.pipeThrough(createDeflateRawDecompressionStream());
    }

    const shouldValidateSize =
      ctx.validateEntrySizes && (decompress || !this.#isCompressed);
    const shouldValidateCrc =
      validateCrc32 && (decompress || !this.#isCompressed);

    if (!decompress && !shouldValidateSize && !shouldValidateCrc) {
      return stream;
    }

    return createOutputStream(stream, {
      expectedSize: shouldValidateSize ? info.uncompressedSize : undefined,
      expectedCrc32: shouldValidateCrc ? info.crc32 : undefined,
      crc32Fn: shouldValidateCrc ? ctx.crc32 : undefined,
      mapError: decompress
        ? (error) =>
            upstreamError && error === upstreamError.reason
              ? error
              : new DecompressionFailed(
                  { name: info.name, reason: describeError(error) },
                  { cause: error },
                )
        : undefined,
    });
  }
}

/**
 * Validate size and CRC32 of the entry's output, and name the entry in
 * decompression errors, in a single pull-through stage.
 */
function createOutputStream(
  input: ReadableStream<Uint8Array<ArrayBuffer>>,
  {
    expectedSize,
    expectedCrc32,
    crc32Fn,
    mapError,
  }: {
    expectedSize: number | undefined;
    expectedCrc32: number | undefined;
    crc32Fn: ((data: Uint8Array, value?: number) => number) | undefined;
    mapError: ((error: unknown) => unknown) | undefined;
  },
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const reader = input.getReader();
  let byteCount = 0;
  let crc = 0;

  const fail = (
    controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>,
    error: Error,
  ) => {
    controller.error(error);
    reader.cancel(error).catch(() => {});
  };

  return new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      async pull(controller) {
        let result: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
        try {
          result = await reader.read();
        } catch (error) {
          controller.error(mapError ? mapError(error) : error);
          return;
        }

        if (result.done) {
          if (expectedSize !== undefined && byteCount < expectedSize) {
            fail(
              controller,
              new Error(
                `Not enough bytes in the stream. Expected ${expectedSize}, got only ${byteCount}.`,
              ),
            );
          } else if (expectedCrc32 !== undefined && crc !== expectedCrc32) {
            fail(
              controller,
              new Error(
                `CRC32 validation failed. Expected ${expectedCrc32}, received ${crc}.`,
              ),
            );
          } else {
            controller.close();
          }
          return;
        }

        const chunk = result.value;
        byteCount += chunk.byteLength;
        if (expectedSize !== undefined && byteCount > expectedSize) {
          fail(
            controller,
            new Error(
              `Too many bytes in the stream. Expected ${expectedSize}, got at least ${byteCount}.`,
            ),
          );
          return;
        }
        if (crc32Fn) {
          crc = crc32Fn(chunk, crc);
        }
        controller.enqueue(chunk);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return "unexpected end of compressed data";
}
