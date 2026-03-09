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
  get generalPurposeBitFlag(): number {
    return this.#info.generalPurposeBitFlag;
  }
  get extraFields(): ReadonlyArray<{ id: number; data: Uint8Array }> {
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
  readable(options?: ReadableOptions): ReadableStream<Uint8Array> {
    const decompress = !(options?.rawEntry ?? !this.#isCompressed);
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

    const rawStream = new ReadableStream<Uint8Array>(
      {
        async start(controller) {
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
            controller.error(new Error("Invalid Local File Header signature"));
            return;
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
            controller.error(
              new Error(
                `File data overflows file bounds: ${fileDataOffset} + ${compressedSize} > ${ctx.centralDirectoryOffset}`,
              ),
            );
            return;
          }
        },

        async pull(controller) {
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
          controller.enqueue(chunk);

          if (bytesRead >= compressedSize) {
            controller.close();
          }
        },
      },
      QUEUING_STRATEGY,
    );

    // Build transform pipeline
    let stream: ReadableStream<Uint8Array> = rawStream;

    if (decompress) {
      stream = stream.pipeThrough(
        new DecompressionStream("deflate-raw") as TransformStream<
          Uint8Array,
          Uint8Array
        >,
      );
    }

    // Validate size and/or CRC32 on decompressed data in a single transform
    const shouldValidateSize =
      ctx.validateEntrySizes && (decompress || !this.#isCompressed);
    const shouldValidateCrc =
      validateCrc32 && (decompress || !this.#isCompressed);

    if (shouldValidateSize || shouldValidateCrc) {
      stream = stream.pipeThrough(
        createValidationStream(
          shouldValidateSize ? info.uncompressedSize : undefined,
          shouldValidateCrc ? info.crc32 : undefined,
          shouldValidateCrc ? ctx.crc32 : undefined,
        ),
      );
    }

    return stream;
  }
}

/**
 * Combined size + CRC32 validation in a single TransformStream.
 */
function createValidationStream(
  expectedSize: number | undefined,
  expectedCrc32: number | undefined,
  crc32Fn: ((data: Uint8Array, value?: number) => number) | undefined,
): TransformStream<Uint8Array, Uint8Array> {
  let byteCount = 0;
  let crc = 0;

  return new TransformStream({
    transform(chunk, controller) {
      byteCount += chunk.byteLength;
      if (expectedSize !== undefined && byteCount > expectedSize) {
        controller.error(
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
    flush(controller) {
      if (expectedSize !== undefined && byteCount < expectedSize) {
        controller.error(
          new Error(
            `Not enough bytes in the stream. Expected ${expectedSize}, got only ${byteCount}.`,
          ),
        );
        return;
      }
      if (expectedCrc32 !== undefined && crc !== expectedCrc32) {
        controller.error(
          new Error(
            `CRC32 validation failed. Expected ${expectedCrc32}, received ${crc}.`,
          ),
        );
      }
    },
  });
}
