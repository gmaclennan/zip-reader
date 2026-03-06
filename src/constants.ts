// ZIP format signatures (little-endian, as read by DataView.getUint32(offset, true))
export const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
export const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
export const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
export const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
export const ZIP64_END_OF_CENTRAL_DIR_SIGNATURE = 0x06064b50;
export const ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE = 0x07064b50;

// Compression methods
export const COMPRESSION_METHOD_STORE = 0;
export const COMPRESSION_METHOD_DEFLATE = 8;

// General purpose bit flags
export const FLAG_ENCRYPTED = 0x1;
export const FLAG_DATA_DESCRIPTOR = 0x8;
export const FLAG_UTF8 = 0x800;
export const FLAG_STRONG_ENCRYPTION = 0x40;

// Size constants
export const LOCAL_FILE_HEADER_SIZE = 30;
export const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
export const EOCD_SIZE = 22;
export const EOCD64_SIZE = 56;
export const EOCD64_LOCATOR_SIZE = 20;
export const MAX_EOCD_COMMENT_SIZE = 0xffff;

// Limits
export const MAX_2_BYTE = 0xffff;
export const MAX_4_BYTE = 0xffffffff;
export const FOUR_GIB = 0x100000000;

// Extra field IDs
export const ZIP64_EXTRA_FIELD_ID = 0x0001;
export const UNICODE_PATH_EXTRA_FIELD_ID = 0x7075;
