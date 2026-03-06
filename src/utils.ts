/**
 * Convert DOS date + time to a JS Date object.
 * DOS dates have no timezone, so we interpret as UTC.
 */
export function dosDateTimeToDate(date: number, time: number): Date {
  const day = date & 0x1f;
  const month = ((date >> 5) & 0xf) - 1;
  const year = ((date >> 9) & 0x7f) + 1980;
  const second = (time & 0x1f) * 2;
  const minute = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  return new Date(Date.UTC(year, month, day, hour, minute, second, 0));
}

/**
 * Validate a filename for dangerous paths.
 * Throws on absolute paths, relative paths with "..", and backslashes.
 */
export function validateFilename(filename: string): void {
  if (filename.indexOf("\\") !== -1) {
    throw new Error(`Invalid characters in filename: ${filename}`);
  }
  if (filename.indexOf("\0") !== -1) {
    throw new Error(`Invalid characters in filename: ${filename}`);
  }
  if (/^[a-zA-Z]:/.test(filename) || /^\//.test(filename)) {
    throw new Error(`Absolute path: ${filename}`);
  }
  if (filename.split("/").indexOf("..") !== -1) {
    throw new Error(`Relative path: ${filename}`);
  }
}

/**
 * Read an unsigned 64-bit integer from a DataView.
 * Throws if the value exceeds Number.MAX_SAFE_INTEGER (2^53 - 1).
 */
export function readUint64LE(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  if (hi > 0x1fffff) {
    throw new Error("ZIP64 value exceeds safe integer range");
  }
  return hi * 0x100000000 + lo;
}

/**
 * Decode a Uint8Array as a UTF-8 string.
 */
const textDecoder = new TextDecoder();
export function decodeUtf8(data: Uint8Array): string {
  return textDecoder.decode(data);
}

/**
 * Read sequential little-endian fields from a DataView.
 * Each field is either a named value `[U16/U32, 'name']` or a skip `number`.
 * Returns an object keyed by field names with their read values.
 */
export const U16 = "u16" as const;
export const U32 = "u32" as const;
export type FieldSize = typeof U16 | typeof U32;
export type FieldDef = readonly [FieldSize, string];

type NamedFields<T extends readonly FieldDef[]> = Extract<
  T[number],
  readonly [FieldSize, string]
>;
type FieldResult<T extends readonly FieldDef[]> = {
  [K in NamedFields<T>[1]]: number;
};

export function readFields<const T extends readonly FieldDef[]>(
  view: DataView,
  fields: T,
  offset = 0,
): FieldResult<T> {
  const result: Record<string, number> = {};
  for (const field of fields) {
    const [type, name] = field;
    if (type === U16) {
      result[name] = view.getUint16(offset, true);
      offset += 2;
    } else if (type === U32) {
      result[name] = view.getUint32(offset, true);
      offset += 4;
    } else {
      throw new Error(`Invalid field type: ${type}`);
    }
  }
  return result as FieldResult<T>;
}
