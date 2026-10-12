import { createErrorClassesByName } from "custom-error-creator";

export const {
  DecompressionFailed,
  DuplicateLocalFileHeader,
  EntryAliasMismatch,
  OverlappingFileData,
  TooManyEntries,
} = createErrorClassesByName([
  {
    code: "DECOMPRESSION_FAILED",
    message: "Failed to decompress entry {name}: {reason}",
  },
  {
    code: "DUPLICATE_LOCAL_FILE_HEADER",
    message:
      "Duplicate local file header offset detected for entry {name} (possible ZIP bomb)",
  },
  {
    code: "ENTRY_ALIAS_MISMATCH",
    message:
      "Entry {name} shares a local file header with an earlier entry but disagrees on size, CRC32 or compression method (possible ZIP bomb)",
  },
  {
    code: "OVERLAPPING_FILE_DATA",
    message:
      "Overlapping file data detected at entry {name}: entries reference more compressed bytes than the archive contains (possible ZIP bomb)",
  },
  {
    code: "TOO_MANY_ENTRIES",
    message:
      "Archive has more than {limit} distinct entries, which is more than can be checked for overlapping file data",
  },
]);

export type DecompressionFailed = InstanceType<typeof DecompressionFailed>;
export type DuplicateLocalFileHeader = InstanceType<
  typeof DuplicateLocalFileHeader
>;
export type EntryAliasMismatch = InstanceType<typeof EntryAliasMismatch>;
export type OverlappingFileData = InstanceType<typeof OverlappingFileData>;
export type TooManyEntries = InstanceType<typeof TooManyEntries>;
