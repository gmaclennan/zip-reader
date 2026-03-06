import type {
  ZipReaderOptions,
  RandomAccessSource,
  EocdInfo,
  CdSource,
  MacArchiveHandler,
} from "./types.js";
import { parseEocd } from "./parse-eocd.js";
import { iterateCdEntries } from "./parse-central-dir.js";
import { ZipEntry } from "./entry.js";
import { crc32 as defaultCrc32 } from "#crc32";

export { ZipEntry } from "./entry.js";
export type {
  ZipReaderOptions,
  RandomAccessSource,
  ReadableOptions,
  MacArchiveHandler,
  MacArchiveFactory,
} from "./types.js";

type NormalizedZipReaderOptions = Required<
  Omit<ZipReaderOptions, "macArchiveFactory">
>;

type ResolvedOptions = NormalizedZipReaderOptions & {
  macArchiveHandler: MacArchiveHandler | null;
};

const DEFAULT_OPTIONS: NormalizedZipReaderOptions = {
  crc32: defaultCrc32,
  validateCrc32: true,
  validateEntrySizes: true,
  validateFilenames: true,
  uniqueEntryOffsets: true,
};

const INTERNAL = Symbol("Constructor only for internal use");

export class ZipReader {
  readonly #eocd: EocdInfo;
  readonly #opts: ResolvedOptions;
  readonly #source: RandomAccessSource;

  private constructor(
    source: RandomAccessSource,
    eocd: EocdInfo,
    opts: ResolvedOptions,
    _internal: symbol,
  ) {
    if (_internal !== INTERNAL) {
      throw new Error("Constructor is private. Use ZipReader.from() instead.");
    }
    this.#source = source;
    this.#eocd = eocd;
    this.#opts = opts;
  }

  get comment(): string {
    return this.#eocd.comment;
  }

  get isZip64(): boolean {
    return this.#eocd.isZip64;
  }

  static async from(
    source: RandomAccessSource,
    options?: ZipReaderOptions,
  ): Promise<ZipReader> {
    const { macArchiveFactory, ...normalizedOptions } = Object.assign(
      {},
      DEFAULT_OPTIONS,
      options,
    );
    const eocd = await parseEocd(source, !!macArchiveFactory);

    let macArchiveHandler: MacArchiveHandler | null = null;
    if (macArchiveFactory) {
      macArchiveHandler = macArchiveFactory(source, eocd);
      await macArchiveHandler.locateCentralDirectory();
    }

    const resolvedOptions = {
      ...normalizedOptions,
      macArchiveHandler,
    };

    return new ZipReader(source, eocd, resolvedOptions, INTERNAL);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ZipEntry> {
    const macArchiveHandler = this.#opts.macArchiveHandler;
    // When Mac handler is active, use its dynamic getters for entryCount etc.
    const cd: CdSource = macArchiveHandler ?? this.#eocd;

    const ctx = {
      source: this.#source,
      centralDirectoryOffset: cd.centralDirectoryOffset,
      crc32: this.#opts.crc32,
      validateCrc32: this.#opts.validateCrc32,
      validateEntrySizes: this.#opts.validateEntrySizes,
      macArchiveHandler,
    };

    // Track seen file header offsets to detect overlapping entries (ZIP bomb technique)
    const seenOffsets = this.#opts.uniqueEntryOffsets
      ? new Set<number>()
      : null;

    let entryIndex = 0;
    for await (const { entry: entryInfo, entryEnd } of iterateCdEntries(
      this.#source,
      cd,
      this.#opts.validateFilenames,
    )) {
      if (entryInfo.fileHeaderOffset + 30 > cd.centralDirectoryOffset) {
        if (!macArchiveHandler?.isMacArchive) {
          throw new Error("Invalid location for file data");
        }
      }

      // Detect overlapping file data — multiple CD entries pointing to the
      // same local file header is the key technique in ZIP bombs.
      if (seenOffsets?.has(entryInfo.fileHeaderOffset)) {
        throw new Error(
          "Duplicate local file header offset detected (possible ZIP bomb)",
        );
      }
      seenOffsets?.add(entryInfo.fileHeaderOffset);

      if (
        macArchiveHandler?.isMacArchive ||
        macArchiveHandler?.isMaybeMacArchive
      ) {
        await macArchiveHandler.processEntry(entryInfo, entryIndex, entryEnd);
      }

      yield new ZipEntry(entryInfo, ctx);
      entryIndex++;
    }
  }

  async close(): Promise<void> {
    if (this.#source.close) {
      await this.#source.close();
    }
  }
}
