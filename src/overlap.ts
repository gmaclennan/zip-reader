import { LOCAL_FILE_HEADER_SIZE } from "./constants.js";
import {
  DuplicateLocalFileHeader,
  EntryAliasMismatch,
  OverlappingFileData,
} from "./errors.js";
import type { CdEntryInfo } from "./types.js";

const FINGERPRINT_SIZE = 4;

// Every Local File Header is at least 30 bytes and all file data precedes the
// Central Directory, so Σ(30 + compressedSize) over distinct header offsets
// cannot exceed the Central Directory offset unless entries overlap.
export class OverlapChecker {
  #remainingDataBytes: number;
  readonly #allowAliases: boolean;
  /** Header offset → slot in #fingerprints (always 0 when aliases are rejected) */
  readonly #seenOffsets = new Map<number, number>();
  #fingerprints: Float64Array;
  #slotCount = 0;

  constructor(centralDirectoryOffset: number, allowAliases: boolean) {
    this.#remainingDataBytes = centralDirectoryOffset;
    this.#allowAliases = allowAliases;
    this.#fingerprints = new Float64Array(allowAliases ? 1024 : 0);
  }

  check(entry: CdEntryInfo): void {
    const slot = this.#seenOffsets.get(entry.fileHeaderOffset);
    if (slot !== undefined) {
      if (!this.#allowAliases) {
        throw new DuplicateLocalFileHeader({ name: entry.name });
      }
      if (!this.#matchesFingerprint(slot, entry)) {
        throw new EntryAliasMismatch({ name: entry.name });
      }
      return;
    }

    this.#remainingDataBytes -= LOCAL_FILE_HEADER_SIZE + entry.compressedSize;
    if (this.#remainingDataBytes < 0) {
      throw new OverlappingFileData({ name: entry.name });
    }

    this.#seenOffsets.set(
      entry.fileHeaderOffset,
      this.#allowAliases ? this.#storeFingerprint(entry) : 0,
    );
  }

  #storeFingerprint(entry: CdEntryInfo): number {
    const slot = this.#slotCount++;
    const start = slot * FINGERPRINT_SIZE;
    if (start + FINGERPRINT_SIZE > this.#fingerprints.length) {
      const grown = new Float64Array(
        Math.max(1024, this.#fingerprints.length * 2),
      );
      grown.set(this.#fingerprints);
      this.#fingerprints = grown;
    }
    this.#fingerprints[start] = entry.compressedSize;
    this.#fingerprints[start + 1] = entry.uncompressedSize;
    this.#fingerprints[start + 2] = entry.crc32;
    this.#fingerprints[start + 3] = entry.compressionMethod;
    return slot;
  }

  #matchesFingerprint(slot: number, entry: CdEntryInfo): boolean {
    const f = this.#fingerprints;
    const start = slot * FINGERPRINT_SIZE;
    return (
      f[start] === entry.compressedSize &&
      f[start + 1] === entry.uncompressedSize &&
      f[start + 2] === entry.crc32 &&
      f[start + 3] === entry.compressionMethod
    );
  }
}
