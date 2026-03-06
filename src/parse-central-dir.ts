import {
  CENTRAL_DIRECTORY_SIGNATURE,
  CENTRAL_DIRECTORY_HEADER_SIZE,
  MAX_4_BYTE,
  ZIP64_EXTRA_FIELD_ID,
  UNICODE_PATH_EXTRA_FIELD_ID,
  FLAG_UTF8,
  FLAG_STRONG_ENCRYPTION,
} from "./constants.js";
import type { CdEntryInfo, CdSource, RandomAccessSource } from "./types.js";
import {
  readUint64LE,
  readFields,
  decodeUtf8,
  validateFilename,
} from "./utils.js";
import { decodeCp437 } from "./cp437.js";
import { crc32 } from "#crc32";
import { CDFH_FIELDS } from "./zip-records.js";

const CD_CHUNK_SIZE = 65536;

/** Entry info with its absolute end position in the Central Directory */
export interface CdEntryWithPosition {
  entry: CdEntryInfo;
  entryEnd: number;
}

/**
 * Manages a sliding buffer over the Central Directory, reading chunks
 * from the source as needed and compacting leftover data.
 */
class CdBuffer {
  #source: RandomAccessSource;
  #cdOffset: number;
  #cdSize: number;
  #cdBytesRead = 0;

  data = new Uint8Array(0);
  cursor = 0;

  constructor(source: RandomAccessSource, cdOffset: number, cdSize: number) {
    this.#source = source;
    this.#cdOffset = cdOffset;
    this.#cdSize = cdSize;
  }

  /** Absolute offset of the current cursor position within the archive. */
  get absoluteCursor(): number {
    return (
      this.#cdOffset + this.#cdBytesRead - (this.data.byteLength - this.cursor)
    );
  }

  /** Ensure at least `needed` bytes are available from cursor. */
  async ensure(needed: number): Promise<boolean> {
    const available = this.data.byteLength - this.cursor;
    if (available >= needed) return true;

    const remaining = this.#cdSize - this.#cdBytesRead;
    if (remaining <= 0) return available >= needed;

    const toRead = Math.min(
      Math.max(CD_CHUNK_SIZE, needed - available),
      remaining,
    );
    const chunk = await this.#source.read(
      this.#cdOffset + this.#cdBytesRead,
      toRead,
    );
    this.#cdBytesRead += chunk.byteLength;

    const newBuf = new Uint8Array(available + chunk.byteLength);
    if (available > 0) {
      newBuf.set(this.data.subarray(this.cursor), 0);
    }
    newBuf.set(chunk, available);
    this.data = newBuf;
    this.cursor = 0;

    return this.data.byteLength >= needed;
  }

  advance(bytes: number): void {
    this.cursor += bytes;
  }
}

/**
 * Async generator that yields CdEntryInfo objects (with position) by streaming
 * the Central Directory from a RandomAccessSource in chunks.
 *
 * `cd.entryCount` is read on each iteration — it may be a getter that returns
 * a dynamic value (e.g. from MacState as it discovers more entries).
 */
export async function* iterateCdEntries(
  source: RandomAccessSource,
  cd: CdSource,
  shouldValidateFilenames: boolean,
): AsyncGenerator<CdEntryWithPosition> {
  if (cd.centralDirectorySize === 0 && cd.entryCount === 0) return;

  const buf = new CdBuffer(
    source,
    cd.centralDirectoryOffset,
    cd.centralDirectorySize,
  );

  for (let i = 0; i < cd.entryCount; i++) {
    // Read fixed header
    if (!(await buf.ensure(CENTRAL_DIRECTORY_HEADER_SIZE))) {
      throw new Error("Invalid Central Directory File Header signature");
    }

    const view = new DataView(
      buf.data.buffer,
      buf.data.byteOffset,
      buf.data.byteLength,
    );
    if (view.getUint32(buf.cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Invalid Central Directory File Header signature");
    }

    const filenameLength = view.getUint16(buf.cursor + 28, true);
    const extraFieldLength = view.getUint16(buf.cursor + 30, true);
    const commentLength = view.getUint16(buf.cursor + 32, true);
    const totalEntrySize =
      CENTRAL_DIRECTORY_HEADER_SIZE +
      filenameLength +
      extraFieldLength +
      commentLength;

    // Read variable-length fields
    if (!(await buf.ensure(totalEntrySize))) {
      throw new Error("Invalid Central Directory File Header");
    }

    const entryEnd = buf.absoluteCursor + totalEntrySize;
    yield {
      entry: parseCdEntry(buf.data, buf.cursor, shouldValidateFilenames),
      entryEnd,
    };
    buf.advance(totalEntrySize);
  }
}

function parseCdEntry(
  data: Uint8Array,
  offset: number,
  shouldValidateFilenames: boolean,
): CdEntryInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const cdh = readFields(view, CDFH_FIELDS, offset + 4);
  const {
    generalPurposeBitFlag,
    filenameLength,
    extraFieldLength,
    commentLength,
  } = cdh;

  let {
    compressedSize,
    uncompressedSize,
    fileHeaderOffset,
    ...cdhPassthrough
  } = cdh;

  if ((generalPurposeBitFlag & FLAG_STRONG_ENCRYPTION) !== 0) {
    throw new Error("Strong encryption is not supported");
  }

  // Variable-length fields
  const varStart = offset + CENTRAL_DIRECTORY_HEADER_SIZE;
  const filenameBytes = data.subarray(varStart, varStart + filenameLength);

  // Parse extra fields
  const extraFieldStart = varStart + filenameLength;
  const extraFieldEnd = extraFieldStart + extraFieldLength;
  const extraFields: Array<{ id: number; data: Uint8Array }> = [];
  let zip64EiefData: Uint8Array | undefined;
  let unicodePathData: Uint8Array | undefined;

  for (let i = extraFieldStart; i < extraFieldEnd - 3; ) {
    const headerId = view.getUint16(i, true);
    const dataSize = view.getUint16(i + 2, true);
    const dataEnd = i + 4 + dataSize;
    if (dataEnd > extraFieldEnd) {
      throw new Error("Extra field length exceeds extra field buffer size");
    }
    const fieldData = data.subarray(i + 4, dataEnd);
    extraFields.push({ id: headerId, data: fieldData });
    if (headerId === ZIP64_EXTRA_FIELD_ID) zip64EiefData = fieldData;
    if (headerId === UNICODE_PATH_EXTRA_FIELD_ID) unicodePathData = fieldData;
    i = dataEnd;
  }

  // Comment
  const commentBytes = data.subarray(
    extraFieldEnd,
    extraFieldEnd + commentLength,
  );

  // ZIP64 extended information
  const isZip64 =
    uncompressedSize === MAX_4_BYTE ||
    compressedSize === MAX_4_BYTE ||
    fileHeaderOffset === MAX_4_BYTE;

  if (isZip64) {
    if (!zip64EiefData) {
      throw new Error("Expected ZIP64 Extended Information Extra Field");
    }
    const z = new DataView(
      zip64EiefData.buffer,
      zip64EiefData.byteOffset,
      zip64EiefData.byteLength,
    );
    let idx = 0;
    if (uncompressedSize === MAX_4_BYTE) {
      if (idx + 8 > zip64EiefData.byteLength) {
        throw new Error(
          "ZIP64 Extended Information Extra Field does not include uncompressed size",
        );
      }
      uncompressedSize = readUint64LE(z, idx);
      idx += 8;
    }
    if (compressedSize === MAX_4_BYTE) {
      if (idx + 8 > zip64EiefData.byteLength) {
        throw new Error(
          "ZIP64 Extended Information Extra Field does not include compressed size",
        );
      }
      compressedSize = readUint64LE(z, idx);
      idx += 8;
    }
    if (fileHeaderOffset === MAX_4_BYTE) {
      if (idx + 8 > zip64EiefData.byteLength) {
        throw new Error(
          "ZIP64 Extended Information Extra Field does not include relative header offset",
        );
      }
      fileHeaderOffset = readUint64LE(z, idx);
    }
  }

  // Decode filename
  const isUtf8 = (generalPurposeBitFlag & FLAG_UTF8) !== 0;
  let name = decodeName(filenameBytes, isUtf8, unicodePathData);

  // Decode comment
  const comment = isUtf8 ? decodeUtf8(commentBytes) : decodeCp437(commentBytes);

  if (shouldValidateFilenames) {
    validateFilename(name);
  } else {
    name = name.replace(/\\/g, "/");
  }

  return {
    name,
    comment,
    compressedSize,
    uncompressedSize,
    fileHeaderOffset,
    isZip64,
    extraFields,
    ...cdhPassthrough,
  };
}

/**
 * Decode a filename, checking for Unicode Path Extra Field override first.
 */
function decodeName(
  filenameBytes: Uint8Array,
  isUtf8: boolean,
  unicodePathData: Uint8Array | undefined,
): string {
  // Unicode Path Extra Field (0x7075) takes priority if valid
  if (unicodePathData && unicodePathData.byteLength >= 5) {
    const upView = new DataView(
      unicodePathData.buffer,
      unicodePathData.byteOffset,
      unicodePathData.byteLength,
    );
    if (
      upView.getUint8(0) === 1 &&
      upView.getUint32(1, true) === crc32(filenameBytes)
    ) {
      return decodeUtf8(unicodePathData.subarray(5));
    }
  }
  return isUtf8 ? decodeUtf8(filenameBytes) : decodeCp437(filenameBytes);
}
