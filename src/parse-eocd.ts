import {
  END_OF_CENTRAL_DIR_SIGNATURE,
  ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE,
  ZIP64_END_OF_CENTRAL_DIR_SIGNATURE,
  EOCD_SIZE,
  EOCD64_LOCATOR_SIZE,
  EOCD64_SIZE,
  MAX_EOCD_COMMENT_SIZE,
  MAX_4_BYTE,
  MAX_2_BYTE,
  CENTRAL_DIRECTORY_HEADER_SIZE,
} from "./constants.js";
import type { EocdInfo, RandomAccessSource } from "./types.js";
import { decodeCp437 } from "./cp437.js";
import { readUint64LE, readFields } from "./utils.js";
import { EOCD_FIELDS } from "./zip-records.js";

/**
 * Parse EOCD from a RandomAccessSource.
 * If allowMacArchiveZip64Fallback is true and ZIP64 EOCDL is missing, marks
 * info.isMacArchive instead of throwing.
 */
export async function parseEocd(
  source: RandomAccessSource,
  allowMacArchiveZip64Fallback = false,
): Promise<EocdInfo> {
  const size = source.size;

  // Read the tail of the file (EOCD + max comment)
  let bufferSize = EOCD_SIZE + MAX_EOCD_COMMENT_SIZE;
  if (size < bufferSize) {
    if (size < EOCD_SIZE) {
      throw new Error("End of Central Directory Record not found");
    }
    bufferSize = size;
  }
  const bufferOffset = size - bufferSize;
  const tail = await source.read(bufferOffset, bufferSize);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  // Locate EOCD
  const relativeEocdOffset = locateEocdSignature(tail, view, bufferSize);
  const eocdOffset = bufferOffset + relativeEocdOffset;

  // Parse EOCD using the tail buffer
  const info = parseEocdRecord(tail, view, relativeEocdOffset);
  info.footerOffset = eocdOffset;

  // Parse ZIP64 if needed
  if (info.isZip64) {
    // Read ZIP64 EOCD Locator (20 bytes before EOCD)
    const zip64EocdlOffset = eocdOffset - EOCD64_LOCATOR_SIZE;
    if (zip64EocdlOffset < 0) {
      throw new Error("Cannot locate ZIP64 End of Central Directory Locator");
    }
    const zip64EocdlData = await source.read(
      zip64EocdlOffset,
      EOCD64_LOCATOR_SIZE,
    );
    const zip64EocdlView = new DataView(
      zip64EocdlData.buffer,
      zip64EocdlData.byteOffset,
      zip64EocdlData.byteLength,
    );

    if (
      zip64EocdlView.getUint32(0, true) !==
      ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE
    ) {
      if (allowMacArchiveZip64Fallback) {
        // Missing ZIP64 EOCDL — likely a Mac OS archive with truncated values.
        info.isMacArchive = true;
        info.isZip64 = false;
        return info;
      }
      throw new Error(
        "Invalid ZIP64 End of Central Directory Locator signature",
      );
    }

    // Get offset of ZIP64 EOCDR
    const zip64EocdrOffset = readUint64LE(zip64EocdlView, 8);
    if (zip64EocdrOffset + EOCD64_SIZE > zip64EocdlOffset) {
      throw new Error("Cannot locate ZIP64 End of Central Directory Record");
    }

    // Read and parse ZIP64 EOCDR
    const zip64EocdrData = await source.read(zip64EocdrOffset, EOCD64_SIZE);
    const zip64EocdrView = new DataView(
      zip64EocdrData.buffer,
      zip64EocdrData.byteOffset,
      zip64EocdrData.byteLength,
    );
    parseZip64EocdrRecord(zip64EocdrView, info);

    // Adjust footer offset
    const zip64EocdrSize = readUint64LE(zip64EocdrView, 4);
    info.footerOffset =
      zip64EocdrOffset + zip64EocdrSize + 12 === zip64EocdlOffset
        ? zip64EocdrOffset
        : zip64EocdlOffset;
  }

  // Validate CD bounds for non-Mac archives
  if (!info.isMacArchive) {
    if (
      info.centralDirectoryOffset + info.centralDirectorySize >
      info.footerOffset
    ) {
      throw new Error(
        "Central Directory extends beyond End of Central Directory Record",
      );
    }
    if (
      info.entryCount * CENTRAL_DIRECTORY_HEADER_SIZE >
      info.centralDirectorySize
    ) {
      throw new Error(
        "Entry count is inconsistent with Central Directory size",
      );
    }
  }

  return info;
}

function locateEocdSignature(
  data: Uint8Array,
  view: DataView,
  size: number,
): number {
  for (let pos = size - EOCD_SIZE; pos >= 0; pos--) {
    if (data[pos] !== 0x50) continue;
    if (view.getUint32(pos, true) !== END_OF_CENTRAL_DIR_SIGNATURE) continue;

    const commentLength = view.getUint16(pos + 20, true);
    if (commentLength === size - pos - EOCD_SIZE) {
      return pos;
    }
  }
  throw new Error("End of Central Directory Record not found");
}

function parseEocdRecord(
  data: Uint8Array,
  view: DataView,
  offset: number,
): EocdInfo {
  const {
    diskNumber,
    entryCount,
    centralDirectorySize,
    centralDirectoryOffset,
    commentLength,
  } = readFields(view, EOCD_FIELDS, offset + 4);

  if (diskNumber !== 0) {
    throw new Error("Multi-disk ZIP files are not supported");
  }

  const comment =
    commentLength > 0
      ? decodeCp437(
          data.subarray(offset + EOCD_SIZE, offset + EOCD_SIZE + commentLength),
        )
      : "";

  const isZip64 =
    entryCount === MAX_2_BYTE ||
    centralDirectoryOffset === MAX_4_BYTE ||
    centralDirectorySize === MAX_4_BYTE;

  return {
    entryCount,
    centralDirectoryOffset,
    centralDirectorySize,
    comment,
    isZip64,
    footerOffset: offset,
    isMacArchive: false,
  };
}

function parseZip64EocdrRecord(view: DataView, info: EocdInfo): void {
  if (view.getUint32(0, true) !== ZIP64_END_OF_CENTRAL_DIR_SIGNATURE) {
    throw new Error("Invalid ZIP64 End of Central Directory Record signature");
  }

  if (info.entryCount === MAX_2_BYTE) {
    info.entryCount = readUint64LE(view, 32);
  }
  if (info.centralDirectorySize === MAX_4_BYTE) {
    info.centralDirectorySize = readUint64LE(view, 40);
  }
  if (info.centralDirectoryOffset === MAX_4_BYTE) {
    info.centralDirectoryOffset = readUint64LE(view, 48);
  }
}
