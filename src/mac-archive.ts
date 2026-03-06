/**
 * Mac OS Archive Utility detection and correction.
 *
 * Mac OS Archive Utility creates faulty ZIP files where:
 * - Entry count is truncated to 16 bits (max 65535)
 * - Central Directory offset/size truncated to 32 bits
 * - Compressed/uncompressed sizes truncated to 32 bits
 *
 * Instead of using ZIP64 extension, it just drops the high bits.
 * This module detects and corrects these issues.
 */

import {
  CENTRAL_DIRECTORY_SIGNATURE,
  CENTRAL_DIRECTORY_HEADER_SIZE,
  DATA_DESCRIPTOR_SIGNATURE,
  LOCAL_FILE_HEADER_SIGNATURE,
  EOCD_SIZE,
  FOUR_GIB,
} from "./constants.js";
import type {
  CdEntryInfo,
  EocdInfo,
  RandomAccessSource,
  MacArchiveHandler,
  MacArchiveFactory,
} from "./types.js";
import { readFields } from "./utils.js";
import { CDFH_FIELDS } from "./zip-records.js";

const MAC_CDH_EXTRA_FIELD_ID = 22613;
const MAC_CDH_EXTRA_FIELD_LENGTH = 8;
const MAC_CDH_EXTRA_FIELDS_LENGTH = MAC_CDH_EXTRA_FIELD_LENGTH + 4;
const MAC_LFH_EXTRA_FIELDS_LENGTH = 16;
const CDH_MIN_LENGTH = CENTRAL_DIRECTORY_HEADER_SIZE; // 46
const CDH_MAX_LENGTH = CDH_MIN_LENGTH + 0xffff * 3;
const CDH_MAX_LENGTH_MAC =
  CDH_MIN_LENGTH + 0xffff + MAC_CDH_EXTRA_FIELDS_LENGTH;

/**
 * Factory function for creating a Mac archive handler.
 * Pass to ZipReaderOptions.macArchiveFactory to enable Mac archive support.
 */
export const macArchive: MacArchiveFactory = (source, eocd) =>
  new MacState(source, eocd);

/**
 * Mutable state for Mac archive detection, updated as entries are read.
 * Owns its own copy of entryCount/centralDirectoryOffset/centralDirectorySize
 * so the original EocdInfo is never mutated.
 */
class MacState implements MacArchiveHandler {
  #isMacArchive = false;
  #isMaybeMacArchive = false;
  #compressedSizesAreCertain = true;
  #entryCountIsCertain = true;
  #centralDirectorySizeIsCertain = true;

  /** Tracks expected file data position in the archive. */
  #fileCursor = 0;

  #entryCount: number;
  #centralDirectoryOffset: number;
  #centralDirectorySize: number;

  readonly #source: RandomAccessSource;
  readonly #eocd: EocdInfo;

  constructor(source: RandomAccessSource, eocd: EocdInfo) {
    this.#source = source;
    this.#eocd = eocd;
    this.#entryCount = eocd.entryCount;
    this.#centralDirectoryOffset = eocd.centralDirectoryOffset;
    this.#centralDirectorySize = eocd.centralDirectorySize;
  }

  get isMacArchive(): boolean {
    return this.#isMacArchive;
  }
  get isMaybeMacArchive(): boolean {
    return this.#isMaybeMacArchive;
  }
  get entryCount(): number {
    return this.#entryCount;
  }
  get centralDirectoryOffset(): number {
    return this.#centralDirectoryOffset;
  }
  get centralDirectorySize(): number {
    // When CD size is uncertain, use the maximum possible so CdBuffer
    // can read all the way to the footer.
    if (!this.#centralDirectorySizeIsCertain) {
      return this.#eocd.footerOffset - this.#centralDirectoryOffset;
    }
    return this.#centralDirectorySize;
  }

  /**
   * After EOCD parsing, locate the real Central Directory.
   * May adjust centralDirectoryOffset, centralDirectorySize, entryCount.
   */
  async locateCentralDirectory(): Promise<void> {
    const eocd = this.#eocd;

    // Mac archives don't use ZIP64
    if (eocd.isZip64 && !eocd.isMacArchive) return;

    // Mac archives have no EOCDR comment
    if (eocd.footerOffset + EOCD_SIZE !== this.#source.size) return;

    // Mac archives have no gap between CD end and EOCDR
    let centralDirectoryEnd =
      this.#centralDirectoryOffset + this.#centralDirectorySize;
    if (centralDirectoryEnd % FOUR_GIB !== eocd.footerOffset % FOUR_GIB) return;

    // If 0 entries and no room for any, it's accurate
    if (
      this.#entryCount === 0 &&
      this.#centralDirectoryOffset + CDH_MIN_LENGTH > eocd.footerOffset
    ) {
      if (this.#centralDirectorySize !== 0) {
        throw new Error("Inconsistent Central Directory size and entry count");
      }
      return;
    }

    // Check size vs entry count consistency
    if (this.#centralDirectorySize < this.#entryCount * CDH_MIN_LENGTH) {
      if (centralDirectoryEnd >= eocd.footerOffset) {
        throw new Error("Inconsistent Central Directory size and entry count");
      }
      this.#isMacArchive = true;
      centralDirectoryEnd = eocd.footerOffset;
      this.#centralDirectorySize =
        centralDirectoryEnd - this.#centralDirectoryOffset;
    }

    if (this.#recalculateEntryCount(0, this.#centralDirectoryOffset)) {
      this.#isMacArchive = true;
    }

    // Try to read first entry at reported offset
    let entry: CdEntryInfo | null = null;
    let alreadyCheckedOffset: number;

    if (!this.#isMacArchive) {
      entry = await this.#readRawEntryAt(this.#centralDirectoryOffset);
      if (entry && !firstEntryMaybeMac(entry)) {
        if (this.#entryCount <= 0) {
          throw new Error(
            "Inconsistent Central Directory size and entry count",
          );
        }
        return;
      }
      alreadyCheckedOffset = this.#centralDirectoryOffset;
    } else {
      alreadyCheckedOffset = -1;
    }

    // Search for CD at offset + n * 4GiB
    if (!entry) {
      let offset =
        eocd.footerOffset -
        Math.max(this.#centralDirectorySize, this.#entryCount * CDH_MIN_LENGTH);
      if (offset % FOUR_GIB < this.#centralDirectoryOffset) {
        if (offset < FOUR_GIB) {
          throw new Error(
            "Inconsistent Central Directory size and entry count",
          );
        }
        offset -= FOUR_GIB;
      }
      offset =
        Math.floor(offset / FOUR_GIB) * FOUR_GIB + this.#centralDirectoryOffset;

      while (offset > alreadyCheckedOffset) {
        entry = await this.#readRawEntryAt(offset);
        if (entry) {
          if (!firstEntryMaybeMac(entry)) {
            throw new Error("Cannot locate Central Directory");
          }
          this.#isMacArchive = true;
          this.#centralDirectoryOffset = offset;
          break;
        }
        offset -= FOUR_GIB;
      }
    }

    if (!entry) {
      if (this.#entryCount !== 0 || this.#centralDirectorySize !== 0) {
        throw new Error("Cannot locate Central Directory");
      }
      return;
    }

    if (this.#entryCount === 0) this.#isMacArchive = true;

    const entryEnd =
      this.#centralDirectoryOffset +
      CDH_MIN_LENGTH +
      entry.filenameLength +
      entry.extraFields.reduce((s, f) => s + 4 + f.data.byteLength, 0) +
      (entry.comment.length > 0
        ? new TextEncoder().encode(entry.comment).byteLength
        : 0);

    if (this.#isMacArchive) {
      centralDirectoryEnd = eocd.footerOffset;
      this.#centralDirectorySize =
        centralDirectoryEnd - this.#centralDirectoryOffset;
      if (this.#centralDirectorySize <= 0) {
        throw new Error("Inconsistent Central Directory size and entry count");
      }
      this.#recalculateEntryCount(1, entryEnd);

      // Check if compressed sizes could be 4GiB larger
      const minTotalDataSize =
        this.#entryCount * 46 +
        entry.compressedSize +
        entry.filenameLength +
        entry.extraFields.length * MAC_LFH_EXTRA_FIELDS_LENGTH;
      if (minTotalDataSize + FOUR_GIB <= this.#centralDirectoryOffset) {
        this.#compressedSizesAreCertain = false;
      }
    } else {
      this.#isMaybeMacArchive = true;
      if (centralDirectoryEnd < eocd.footerOffset) {
        this.#centralDirectorySizeIsCertain = false;
        this.#entryCountIsCertain = false;
      } else {
        this.#recalculateEntryCount(1, entryEnd);
      }
    }

    // Check if entry count could be higher
    if (
      this.#entryCountIsCertain &&
      !entryCountIsCertain(this.#entryCount - 1, centralDirectoryEnd - entryEnd)
    ) {
      this.#entryCountIsCertain = false;
    }

    this.#fileCursor = 0;
  }

  /**
   * Called for each entry during iteration. Validates and adjusts Mac state.
   * May modify entry.fileHeaderOffset and entry.compressedSize.
   */
  async processEntry(
    entry: CdEntryInfo,
    entryIndex: number,
    entryEnd: number,
  ): Promise<void> {
    const centralDirectoryEnd =
      this.#centralDirectoryOffset + this.#centralDirectorySize;

    if (entryIndex > 0) {
      if (this.#isMacArchive) {
        if (
          !entryMaybeMac(entry) ||
          entry.fileHeaderOffset !== this.#fileCursor % FOUR_GIB
        ) {
          throw new Error("Inconsistent Central Directory structure");
        }
        entry.fileHeaderOffset = this.#fileCursor;

        if (!this.#entryCountIsCertain) {
          this.#recalculateEntryCount(entryIndex + 1, entryEnd);
          this.#recalculateEntryCountIsCertain(entryIndex + 1, entryEnd);
        }
      } else if (this.#isMaybeMacArchive) {
        if (this.#fileCursor >= FOUR_GIB) {
          if (
            !entryMaybeMac(entry) ||
            entry.fileHeaderOffset !== this.#fileCursor % FOUR_GIB
          ) {
            throw new Error("Inconsistent Central Directory structure");
          }
          this.#setAsMacArchive(entryIndex + 1, entryEnd);
        } else if (
          !entryMaybeMac(entry) ||
          entry.fileHeaderOffset !== this.#fileCursor
        ) {
          this.#setAsNotMacArchive();
          if (entryIndex >= this.#entryCount) {
            throw new Error("Central Directory contains too many entries");
          }
        } else if (
          !this.#centralDirectorySizeIsCertain &&
          entryEnd + (this.#entryCount - entryIndex - 1) * CDH_MIN_LENGTH >
            centralDirectoryEnd
        ) {
          this.#setAsMacArchive(entryIndex + 1, entryEnd);
        } else if (!this.#entryCountIsCertain) {
          if (this.#recalculateEntryCount(entryIndex + 1, entryEnd)) {
            this.#setAsMacArchive(entryIndex + 1, entryEnd);
          } else if (this.#centralDirectorySizeIsCertain) {
            this.#recalculateEntryCountIsCertain(entryIndex + 1, entryEnd);
          }
        }
      }
    }

    // Calculate file data offset assuming Mac layout
    const fileDataOffsetIfMac =
      entry.fileHeaderOffset +
      30 +
      entry.filenameLength +
      entry.extraFields.length * MAC_LFH_EXTRA_FIELDS_LENGTH;

    // Determine compressed size if uncertain
    if (!this.#compressedSizesAreCertain) {
      const isNowCertain = await this.#determineCompressedSize(
        entry,
        fileDataOffsetIfMac,
      );
      if (isNowCertain) this.#compressedSizesAreCertain = true;
    }

    // Track file cursor for Mac layout validation
    if (this.#isMacArchive || this.#isMaybeMacArchive) {
      this.#fileCursor =
        fileDataOffsetIfMac +
        entry.compressedSize +
        (entry.compressionMethod === 8 ? 16 : 0);
    }
  }

  /**
   * Validate LFH fields against Mac signature when opening a stream.
   */
  validateLocalFileHeader(
    entry: CdEntryInfo,
    localCrc32: number,
    localCompressedSize: number,
    localUncompressedSize: number,
    filenameLength: number,
    extraFieldsLength: number,
  ): void {
    const matchesMacSignature =
      localCrc32 === 0 &&
      localCompressedSize === 0 &&
      localUncompressedSize === 0 &&
      filenameLength === entry.filenameLength &&
      extraFieldsLength ===
        entry.extraFields.length * MAC_LFH_EXTRA_FIELDS_LENGTH;

    if (this.#isMacArchive) {
      if (!matchesMacSignature) {
        throw new Error("Misidentified Mac OS Archive Utility ZIP");
      }
    } else if (this.#isMaybeMacArchive && !matchesMacSignature) {
      this.#setAsNotMacArchive();
    }
  }

  // --- Private methods ---

  async #readRawEntryAt(offset: number): Promise<CdEntryInfo | null> {
    if (offset + CDH_MIN_LENGTH > this.#eocd.footerOffset) return null;

    const buf = await this.#source.read(offset, CDH_MIN_LENGTH);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    if (view.getUint32(0, true) !== CENTRAL_DIRECTORY_SIGNATURE) return null;

    const {
      versionMadeBy,
      versionNeededToExtract,
      generalPurposeBitFlag,
      compressionMethod,
      lastModTime,
      lastModDate,
      crc32,
      compressedSize,
      uncompressedSize,
      filenameLength,
      extraFieldLength,
      commentLength,
      /* skip disk number start */
      internalFileAttributes,
      externalFileAttributes,
      fileHeaderOffset,
    } = readFields(view, CDFH_FIELDS, 4);

    const varSize = filenameLength + extraFieldLength + commentLength;
    const entryEnd = offset + CDH_MIN_LENGTH + varSize;

    if (entryEnd > this.#eocd.footerOffset) return null;

    const varBuf = await this.#source.read(offset + CDH_MIN_LENGTH, varSize);

    // Parse extra fields
    const extraFields: Array<{ id: number; data: Uint8Array }> = [];
    const efStart = filenameLength;
    const efEnd = efStart + extraFieldLength;
    for (let i = efStart; i < efEnd - 3; ) {
      const efView = new DataView(
        varBuf.buffer,
        varBuf.byteOffset,
        varBuf.byteLength,
      );
      const headerId = efView.getUint16(i, true);
      const dataSize = efView.getUint16(i + 2, true);
      const dataEnd = i + 4 + dataSize;
      if (dataEnd > efEnd) break;
      extraFields.push({
        id: headerId,
        data: varBuf.subarray(i + 4, dataEnd),
      });
      i = dataEnd;
    }

    return {
      name: "",
      comment: new TextDecoder().decode(
        varBuf.subarray(efEnd, efEnd + commentLength),
      ),
      compressedSize,
      uncompressedSize,
      crc32,
      compressionMethod,
      lastModTime,
      lastModDate,
      generalPurposeBitFlag,
      versionMadeBy,
      versionNeededToExtract,
      internalFileAttributes,
      externalFileAttributes,
      fileHeaderOffset,
      filenameLength,
      isZip64:
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        fileHeaderOffset === 0xffffffff,
      extraFields,
    };
  }

  async #determineCompressedSize(
    entry: CdEntryInfo,
    fileDataOffsetIfMac: number,
  ): Promise<boolean> {
    let numEntriesRemaining = this.#entryCount - 1;
    let dataSpaceRemaining =
      this.#centralDirectoryOffset -
      fileDataOffsetIfMac -
      entry.compressedSize -
      (entry.compressionMethod === 8 ? 16 : 0);

    if (dataSpaceRemaining - numEntriesRemaining * 30 < FOUR_GIB) return true;

    if (entry.compressionMethod === 0) {
      return false;
    }

    // Search for Data Descriptor after file data
    let fileDataEnd = fileDataOffsetIfMac + entry.compressedSize;
    while (true) {
      const buf = await this.#source.read(fileDataEnd, 20);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      if (
        view.getUint32(0, true) === DATA_DESCRIPTOR_SIGNATURE &&
        view.getUint32(4, true) === entry.crc32 &&
        view.getUint32(8, true) === entry.compressedSize &&
        view.getUint32(12, true) === entry.uncompressedSize &&
        (view.getUint32(16, true) === LOCAL_FILE_HEADER_SIGNATURE ||
          fileDataEnd + 16 === this.#centralDirectoryOffset)
      ) {
        break;
      }

      if (this.#compressedSizesAreCertain) {
        fileDataEnd = -1;
        break;
      }

      fileDataEnd += FOUR_GIB;
      if (fileDataEnd + 16 > this.#centralDirectoryOffset) {
        fileDataEnd = -1;
        break;
      }
    }

    if (fileDataEnd === -1) {
      if (this.#isMacArchive) {
        throw new Error("Cannot locate file Data Descriptor");
      }
      if (this.#isMaybeMacArchive) this.#setAsNotMacArchive();
      return true;
    }

    if (fileDataEnd !== fileDataOffsetIfMac + entry.compressedSize) {
      if (!this.#isMacArchive) {
        if (!this.#isMaybeMacArchive) {
          throw new Error("Cannot locate file Data Descriptor");
        }
        this.#isMacArchive = true;
        this.#isMaybeMacArchive = false;
        if (!this.#centralDirectorySizeIsCertain) {
          this.#centralDirectorySize =
            this.#eocd.footerOffset - this.#centralDirectoryOffset;
          this.#centralDirectorySizeIsCertain = true;
        }
      }
      entry.compressedSize = fileDataEnd - fileDataOffsetIfMac;
    }

    numEntriesRemaining = this.#entryCount - 1;
    dataSpaceRemaining = this.#centralDirectoryOffset - fileDataEnd - 16;
    return dataSpaceRemaining - numEntriesRemaining * 30 < FOUR_GIB;
  }

  #recalculateEntryCount(numEntriesRead: number, entryCursor: number): boolean {
    const numEntriesRemaining = this.#entryCount - numEntriesRead;
    const cdRemaining =
      this.#centralDirectoryOffset + this.#centralDirectorySize - entryCursor;
    const entryMaxLen = this.#isMacArchive
      ? CDH_MAX_LENGTH_MAC
      : CDH_MAX_LENGTH;
    if (numEntriesRemaining * entryMaxLen >= cdRemaining) return false;

    const minEntriesRemaining = Math.ceil(cdRemaining / CDH_MAX_LENGTH_MAC);
    this.#entryCount +=
      (minEntriesRemaining - numEntriesRemaining + 0xffff) & 0x10000;
    return true;
  }

  #recalculateEntryCountIsCertain(
    numEntriesRead: number,
    entryCursor: number,
  ): void {
    const numEntriesRemaining = this.#entryCount - numEntriesRead;
    const cdRemaining =
      this.#centralDirectoryOffset + this.#centralDirectorySize - entryCursor;
    if (entryCountIsCertain(numEntriesRemaining, cdRemaining)) {
      this.#entryCountIsCertain = true;
    }
  }

  #setAsMacArchive(numEntriesRead: number, entryCursor: number): void {
    this.#isMacArchive = true;
    this.#isMaybeMacArchive = false;
    if (!this.#centralDirectorySizeIsCertain) {
      this.#centralDirectorySize =
        this.#eocd.footerOffset - this.#centralDirectoryOffset;
      this.#centralDirectorySizeIsCertain = true;
    }
    if (!this.#entryCountIsCertain) {
      this.#recalculateEntryCount(numEntriesRead, entryCursor);
      this.#recalculateEntryCountIsCertain(numEntriesRead, entryCursor);
    }
  }

  #setAsNotMacArchive(): void {
    this.#isMaybeMacArchive = false;
    this.#entryCountIsCertain = true;
    this.#centralDirectorySizeIsCertain = true;
    this.#compressedSizesAreCertain = true;
    this.#fileCursor = 0;
  }
}

function entryCountIsCertain(
  entryCount: number,
  centralDirectorySize: number,
): boolean {
  return (entryCount + 0x10000) * CDH_MIN_LENGTH > centralDirectorySize;
}

function firstEntryMaybeMac(entry: CdEntryInfo): boolean {
  if (entry.fileHeaderOffset !== 0) return false;
  return entryMaybeMac(entry);
}

function entryMaybeMac(entry: CdEntryInfo): boolean {
  if (entry.versionMadeBy !== 789) return false;
  if (entry.comment.length !== 0) return false;
  if (entry.isZip64) return false;

  if (entry.versionNeededToExtract === 20) {
    if (
      entry.generalPurposeBitFlag !== 8 ||
      entry.compressionMethod !== 8 ||
      entry.name.endsWith("/")
    ) {
      return false;
    }
  } else if (entry.versionNeededToExtract === 10) {
    if (
      entry.generalPurposeBitFlag !== 0 ||
      entry.compressionMethod !== 0 ||
      entry.uncompressedSize !== entry.compressedSize
    )
      return false;

    if (entry.extraFields.length === 0) {
      if (entry.compressedSize === 0) return false;
      return true;
    }

    if (entry.compressedSize !== 0 || entry.crc32 !== 0) return false;
  } else {
    return false;
  }

  if (
    entry.extraFields.length !== 1 ||
    entry.extraFields[0].id !== MAC_CDH_EXTRA_FIELD_ID ||
    entry.extraFields[0].data.byteLength !== MAC_CDH_EXTRA_FIELD_LENGTH
  )
    return false;

  return true;
}
