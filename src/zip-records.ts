import { U16, U32, type FieldDef } from "./utils.js";

/**
 * Central Directory File Header (CDFH) field layout: all fixed fields through fileHeaderOffset
 */
export const CDFH_FIELDS = [
  [U16, "versionMadeBy"],
  [U16, "versionNeededToExtract"],
  [U16, "generalPurposeBitFlag"],
  [U16, "compressionMethod"],
  [U16, "lastModTime"],
  [U16, "lastModDate"],
  [U32, "crc32"],
  [U32, "compressedSize"],
  [U32, "uncompressedSize"],
  [U16, "filenameLength"],
  [U16, "extraFieldLength"],
  [U16, "commentLength"],
  [U16, "diskNumberStart"],
  [U16, "internalFileAttributes"],
  [U32, "externalFileAttributes"],
  [U32, "fileHeaderOffset"],
] as const satisfies FieldDef[];

/**
 * End of Central Directory (EOCD) field layout: all fixed fields through commentLength
 */
export const EOCD_FIELDS = [
  [U16, "diskNumber"],
  [U16, "diskOfCentralDirectory"],
  [U16, "entryCountOnDisk"],
  [U16, "entryCount"],
  [U32, "centralDirectorySize"],
  [U32, "centralDirectoryOffset"],
  [U16, "commentLength"],
] as const satisfies readonly FieldDef[];

/**
 * Local File Header (LFH) field layout: all fixed fields through extraFieldsLength
 */
export const LFH_FIELDS = [
  [U32, "signature"],
  [U16, "versionNeededToExtract"],
  [U16, "generalPurposeBitFlag"],
  [U16, "compressionMethod"],
  [U16, "lastModTime"],
  [U16, "lastModDate"],
  [U32, "localCrc32"],
  [U32, "localCompressedSize"],
  [U32, "localUncompressedSize"],
  [U16, "filenameLength"],
  [U16, "extraFieldsLength"],
] as const satisfies FieldDef[];
