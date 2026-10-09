import { createErrorClassesByName } from "custom-error-creator";

export const {
  DuplicateLocalFileHeader,
  EntryAliasMismatch,
  OverlappingFileData,
} = createErrorClassesByName([
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
]);

export type DuplicateLocalFileHeader = InstanceType<
  typeof DuplicateLocalFileHeader
>;
export type EntryAliasMismatch = InstanceType<typeof EntryAliasMismatch>;
export type OverlappingFileData = InstanceType<typeof OverlappingFileData>;
