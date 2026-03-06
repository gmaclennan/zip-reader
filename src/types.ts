export interface ZipReaderOptions {
  /** Custom CRC32 function */
  crc32?: (data: Uint8Array, value?: number) => number;
  /** Validate CRC32 checksums when streaming entry data. Default: true */
  validateCrc32?: boolean;
  /** Validate uncompressed entry sizes. Default: true */
  validateEntrySizes?: boolean;
  /** Validate filenames for dangerous paths. Default: true */
  validateFilenames?: boolean;
  /**
   * Require each entry to have a unique local file header offset. Default: true
   *
   * When true, rejects archives where multiple Central Directory entries point
   * to the same Local File Header — the key technique in overlapping ZIP bombs.
   *
   * Set to false if the archive legitimately uses shared file data (e.g. tile
   * maps with deduplicated tiles). In that case, callers should track total
   * decompressed bytes themselves to guard against excessive output.
   */
  uniqueEntryOffsets?: boolean;
  /** Factory for Mac OS Archive Utility support. Import from 'zip-reader/mac'. */
  macArchiveFactory?: MacArchiveFactory;
}

export interface RandomAccessSource {
  /** Read `length` bytes starting at `offset` */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Total size of the source in bytes */
  readonly size: number;
  /** Optional cleanup */
  close?(): Promise<void>;
}

export interface ReadableOptions {
  /** Decompress compressed entries. Default: true */
  decompress?: boolean;
  /** Validate CRC32 checksum. Default: true */
  validateCrc32?: boolean;
}

/** Internal parsed EOCD info */
export interface EocdInfo {
  entryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  comment: string;
  isZip64: boolean;
  footerOffset: number;
  /** Set when ZIP64 EOCDL was expected but missing — likely a Mac OS archive */
  isMacArchive: boolean;
}

/** Internal parsed Central Directory entry info */
export interface CdEntryInfo {
  name: string;
  comment: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  compressionMethod: number;
  lastModTime: number;
  lastModDate: number;
  generalPurposeBitFlag: number;
  versionMadeBy: number;
  versionNeededToExtract: number;
  internalFileAttributes: number;
  externalFileAttributes: number;
  fileHeaderOffset: number;
  filenameLength: number;
  isZip64: boolean;
  extraFields: Array<{ id: number; data: Uint8Array }>;
}

/** Subset of EocdInfo/MacArchiveHandler used by CD iteration */
export interface CdSource {
  readonly entryCount: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
}

/** Handler for Mac OS Archive Utility edge cases */
export interface MacArchiveHandler {
  readonly entryCount: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
  readonly isMacArchive: boolean;
  readonly isMaybeMacArchive: boolean;

  locateCentralDirectory(): Promise<void>;
  processEntry(
    entry: CdEntryInfo,
    entryIndex: number,
    entryEnd: number
  ): Promise<void>;
  validateLocalFileHeader(
    entry: CdEntryInfo,
    localCrc32: number,
    localCompressedSize: number,
    localUncompressedSize: number,
    filenameLength: number,
    extraFieldsLength: number
  ): void;
}

export type MacArchiveFactory = (
  source: RandomAccessSource,
  eocd: EocdInfo
) => MacArchiveHandler;
