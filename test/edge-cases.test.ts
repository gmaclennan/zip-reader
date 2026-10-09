import { describe, it, expect, expectTypeOf } from "vitest";
import {
  ZipReader,
  ZipEntry,
  DecompressionFailed,
  DuplicateLocalFileHeader,
  EntryAliasMismatch,
  OverlappingFileData,
} from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import type { RandomAccessSource } from "../src/types.js";
import { deflateRawZeros } from "./fixture-helpers.js";

const isBrowser = typeof window !== "undefined";

async function collectStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Simple CRC32 for building test ZIPs */
function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) * 0xedb88320);
    }
  }
  return ~crc >>> 0;
}

/**
 * Build a minimal valid ZIP with one stored entry.
 * Returns the full ZIP and the offsets of key structures.
 */
function buildZip(
  filename: string,
  content: Uint8Array,
  options?: {
    cdhFlags?: number;
    extraField?: Uint8Array;
    cdhExtraField?: Uint8Array;
  },
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(filename);
  const crc = crc32(content);
  const extraField = options?.extraField ?? new Uint8Array(0);
  const cdhExtraField = options?.cdhExtraField ?? new Uint8Array(0);
  const flags = options?.cdhFlags ?? 0;

  // Local File Header
  const lfh = new Uint8Array(30 + nameBytes.length + extraField.length);
  const lfhView = new DataView(lfh.buffer);
  lfhView.setUint32(0, 0x04034b50, true);
  lfhView.setUint16(4, 20, true);
  lfhView.setUint16(6, flags, true);
  lfhView.setUint16(8, 0, true); // store
  lfhView.setUint16(10, 0, true);
  lfhView.setUint16(12, 0x5421, true);
  lfhView.setUint32(14, crc, true);
  lfhView.setUint32(18, content.length, true);
  lfhView.setUint32(22, content.length, true);
  lfhView.setUint16(26, nameBytes.length, true);
  lfhView.setUint16(28, extraField.length, true);
  lfh.set(nameBytes, 30);
  lfh.set(extraField, 30 + nameBytes.length);

  // Central Directory Header
  const cdh = new Uint8Array(46 + nameBytes.length + cdhExtraField.length);
  const cdhView = new DataView(cdh.buffer);
  cdhView.setUint32(0, 0x02014b50, true);
  cdhView.setUint16(4, 45, true);
  cdhView.setUint16(6, 20, true);
  cdhView.setUint16(8, flags, true);
  cdhView.setUint16(10, 0, true); // store
  cdhView.setUint16(12, 0, true);
  cdhView.setUint16(14, 0x5421, true);
  cdhView.setUint32(16, crc, true);
  cdhView.setUint32(20, content.length, true);
  cdhView.setUint32(24, content.length, true);
  cdhView.setUint16(28, nameBytes.length, true);
  cdhView.setUint16(30, cdhExtraField.length, true);
  cdhView.setUint16(32, 0, true); // comment length
  cdhView.setUint16(34, 0, true); // disk number start
  cdhView.setUint16(36, 0, true); // internal attrs
  cdhView.setUint32(38, 0, true); // external attrs
  cdhView.setUint32(42, 0, true); // offset of local header
  cdh.set(nameBytes, 46);
  cdh.set(cdhExtraField, 46 + nameBytes.length);

  const cdOffset = lfh.length + content.length;

  // EOCD
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, cdh.length, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true);

  const zip = new Uint8Array(
    lfh.length + content.length + cdh.length + eocd.length,
  );
  let offset = 0;
  zip.set(lfh, offset);
  offset += lfh.length;
  zip.set(content, offset);
  offset += content.length;
  zip.set(cdh, offset);
  offset += cdh.length;
  zip.set(eocd, offset);

  return zip;
}

/** Build a minimal empty ZIP (just EOCD, 0 entries) */
function buildEmptyZip(): Uint8Array<ArrayBuffer> {
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  return eocd;
}

describe("Edge cases and malformed ZIP handling", () => {
  describe("too-small source", () => {
    it("rejects source smaller than EOCD", async () => {
      await expect(
        ZipReader.from(new BufferSource(new Uint8Array(10))),
      ).rejects.toThrow("End of Central Directory Record not found");
    });

    it("rejects empty source", async () => {
      await expect(
        ZipReader.from(new BufferSource(new Uint8Array(0))),
      ).rejects.toThrow("End of Central Directory Record not found");
    });
  });

  describe("EOCD validation", () => {
    it("rejects ZIP with invalid EOCD signature", async () => {
      const data = new Uint8Array(22);
      // Wrong signature
      data[0] = 0x00;
      await expect(ZipReader.from(new BufferSource(data))).rejects.toThrow(
        "End of Central Directory Record not found",
      );
    });

    it("rejects multi-disk ZIP", async () => {
      const eocd = new Uint8Array(22);
      const view = new DataView(eocd.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(4, 1, true); // disk number = 1
      await expect(ZipReader.from(new BufferSource(eocd))).rejects.toThrow(
        "Multi-disk ZIP files are not supported",
      );
    });

    it("rejects entry count inconsistent with CD size", async () => {
      // Craft a ZIP where entry count is too large for CD size
      const eocd = new Uint8Array(22);
      const view = new DataView(eocd.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, 100, true); // 100 entries
      view.setUint16(10, 100, true); // 100 total entries
      view.setUint32(12, 46, true); // CD size = 46 (only fits 1 entry)
      view.setUint32(16, 0, true); // CD offset = 0

      // Need actual source bytes to cover the CD region
      const data = new Uint8Array(22 + 46);
      data.set(eocd, 46);

      // Rebuild with correct offsets
      const full = new Uint8Array(46 + 22);
      const fullView = new DataView(full.buffer);
      // EOCD at offset 46
      fullView.setUint32(46, 0x06054b50, true);
      fullView.setUint16(46 + 8, 100, true);
      fullView.setUint16(46 + 10, 100, true);
      fullView.setUint32(46 + 12, 46, true); // CD size
      fullView.setUint32(46 + 16, 0, true); // CD offset

      await expect(ZipReader.from(new BufferSource(full))).rejects.toThrow(
        "Entry count is inconsistent with Central Directory size",
      );
    });

    it("rejects CD that extends beyond EOCD", async () => {
      const full = new Uint8Array(22);
      const view = new DataView(full.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, 1, true);
      view.setUint16(10, 1, true);
      view.setUint32(12, 100, true); // CD size much larger than file
      view.setUint32(16, 0, true); // CD offset = 0

      await expect(ZipReader.from(new BufferSource(full))).rejects.toThrow(
        "Central Directory extends beyond End of Central Directory Record",
      );
    });
  });

  describe("Central Directory validation", () => {
    it("rejects invalid CD signature", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content);
      const view = new DataView(zip.buffer);

      // Find CD offset from EOCD
      const eocdOffset = zip.length - 22;
      const cdOffset = view.getUint32(eocdOffset + 16, true);

      // Corrupt CD signature
      view.setUint32(cdOffset, 0x00000000, true);

      await expect(
        (async () => {
          const reader = await ZipReader.from(new BufferSource(zip));
          for await (const _entry of reader) {
            // iterate
          }
        })(),
      ).rejects.toThrow("Invalid Central Directory File Header signature");
    });
  });

  describe("filename validation", () => {
    it("rejects backslashes in filenames", async () => {
      const zip = buildZip("dir\\file.txt", new TextEncoder().encode("test"));
      await expect(
        (async () => {
          const reader = await ZipReader.from(new BufferSource(zip));
          for await (const _entry of reader) {
            // iterate
          }
        })(),
      ).rejects.toThrow("Invalid characters in filename");
    });

    it("rejects null bytes in filenames", async () => {
      const zip = buildZip("file\0.txt", new TextEncoder().encode("test"), {
        cdhFlags: 0x800, // UTF-8 flag so the null byte is preserved
      });
      // Also set the UTF-8 flag in the LFH
      const view = new DataView(zip.buffer);
      view.setUint16(6, 0x800, true);

      await expect(
        (async () => {
          const reader = await ZipReader.from(new BufferSource(zip));
          for await (const _entry of reader) {
            // iterate
          }
        })(),
      ).rejects.toThrow("Invalid characters in filename");
    });

    it("rejects absolute paths", async () => {
      const zip = buildZip("/etc/passwd", new TextEncoder().encode("test"));
      await expect(
        (async () => {
          const reader = await ZipReader.from(new BufferSource(zip));
          for await (const _entry of reader) {
            // iterate
          }
        })(),
      ).rejects.toThrow("Absolute path");
    });

    it("rejects directory traversal", async () => {
      const zip = buildZip(
        "../../../etc/passwd",
        new TextEncoder().encode("test"),
      );
      await expect(
        (async () => {
          const reader = await ZipReader.from(new BufferSource(zip));
          for await (const _entry of reader) {
            // iterate
          }
        })(),
      ).rejects.toThrow("Relative path");
    });

    it("rejects Windows drive letter paths", async () => {
      const zip = buildZip("C:file.txt", new TextEncoder().encode("test"));
      await expect(
        (async () => {
          const reader = await ZipReader.from(new BufferSource(zip));
          for await (const _entry of reader) {
            // iterate
          }
        })(),
      ).rejects.toThrow("Absolute path");
    });

    it("allows sloppy filenames when validation is disabled", async () => {
      const zip = buildZip("dir\\file.txt", new TextEncoder().encode("test"));
      const reader = await ZipReader.from(new BufferSource(zip), {
        skipFilenameValidation: true,
      });
      const entries: ZipEntry[] = [];
      for await (const entry of reader) {
        entries.push(entry);
      }
      expect(entries.length).toBe(1);
      // Backslashes should be normalized to forward slashes
      expect(entries[0].name).toBe("dir/file.txt");
    });
  });

  describe("encryption detection", () => {
    it("rejects strong encryption", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content, { cdhFlags: 0x40 });
      // Also set LFH flags
      const view = new DataView(zip.buffer);
      view.setUint16(6, 0x40, true);

      await expect(
        (async () => {
          const reader = await ZipReader.from(new BufferSource(zip));
          for await (const _entry of reader) {
            // iterate
          }
        })(),
      ).rejects.toThrow("Strong encryption is not supported");
    });

    it("detects traditional encryption via flag", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content, { cdhFlags: 0x1 });
      const view = new DataView(zip.buffer);
      view.setUint16(6, 0x1, true);

      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        expect(entry.isEncrypted).toBe(true);
        expect(() => entry.readable()).toThrow("Decryption is not supported");
      }
    });
  });

  describe("local file header validation", () => {
    it("rejects invalid LFH signature when streaming", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content);
      // Corrupt LFH signature
      const view = new DataView(zip.buffer);
      view.setUint32(0, 0x00000000, true);

      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        const stream = entry.readable();
        await expect(collectStream(stream)).rejects.toThrow(
          "Invalid Local File Header signature",
        );
      }
    });

    it("rejects a declared compressed size that overflows into CD", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content);
      const view = new DataView(zip.buffer);

      const eocdOffset = zip.length - 22;
      const cdOffset = view.getUint32(eocdOffset + 16, true);
      // Set compressedSize to something huge in CD header
      view.setUint32(cdOffset + 20, 999999, true);

      const reader = await ZipReader.from(new BufferSource(zip));
      await expect(
        (async () => {
          for await (const _entry of reader) {
            // iterate
          }
        })(),
      ).rejects.toThrow("Overlapping file data");
    });

    it("rejects file data that overflows into CD when streaming", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content);
      const view = new DataView(zip.buffer);

      // The CD sizes fit, but the LFH claims an extra field that pushes the
      // data past the start of the CD
      view.setUint16(28, 100, true);

      const reader = await ZipReader.from(new BufferSource(zip), {
        skipCrc32: true,
        skipSizeCheck: true,
      });
      for await (const entry of reader) {
        const stream = entry.readable();
        await expect(collectStream(stream)).rejects.toThrow(
          "File data overflows file bounds",
        );
      }
    });
  });

  describe("source bounds checking", () => {
    it("BufferSource rejects out-of-bounds read", async () => {
      const source = new BufferSource(new Uint8Array(10));
      await expect(source.read(5, 10)).rejects.toThrow("Read out of bounds");
    });

    it("BufferSource rejects negative offset", async () => {
      const source = new BufferSource(new Uint8Array(10));
      await expect(source.read(-1, 5)).rejects.toThrow("Read out of bounds");
    });

    it("BufferSource types exclude SharedArrayBuffer data", () => {
      expectTypeOf(BufferSource).constructorParameters.toEqualTypeOf<
        [Uint8Array<ArrayBuffer> | ArrayBuffer]
      >();
    });

    it("BufferSource allows valid reads", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const source = new BufferSource(data);
      const result = await source.read(1, 3);
      expect(result).toEqual(new Uint8Array([2, 3, 4]));
    });
  });

  describe("empty and zero-size entries", () => {
    it("handles zip with zero entries", async () => {
      const zip = buildEmptyZip();
      const reader = await ZipReader.from(new BufferSource(zip));
      const entries: ZipEntry[] = [];
      for await (const entry of reader) {
        entries.push(entry);
      }
      expect(entries.length).toBe(0);
    });

    it("handles entry with zero-length content", async () => {
      const zip = buildZip("empty.txt", new Uint8Array(0));
      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        expect(entry.name).toBe("empty.txt");
        expect(entry.uncompressedSize).toBe(0);
        const stream = entry.readable();
        const data = await collectStream(stream);
        expect(data.length).toBe(0);
      }
    });

    it("handles directory entries", async () => {
      const zip = buildZip("mydir/", new Uint8Array(0));
      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        expect(entry.name).toBe("mydir/");
        expect(entry.isDirectory).toBe(true);
      }
    });
  });

  describe("CRC32 validation edge cases", () => {
    it("validates CRC32 on stored (uncompressed) entries", async () => {
      const content = new TextEncoder().encode("Hello, World!");
      const zip = buildZip("test.txt", content);

      // Corrupt file data
      zip[30 + 8 + 2] ^= 0xff;

      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        const stream = entry.readable();
        await expect(collectStream(stream)).rejects.toThrow(
          "CRC32 validation failed",
        );
      }
    });

    it("skips CRC32 validation when disabled globally", async () => {
      const content = new TextEncoder().encode("Hello, World!");
      const zip = buildZip("test.txt", content);
      zip[30 + 8 + 2] ^= 0xff; // corrupt data

      const reader = await ZipReader.from(new BufferSource(zip), {
        skipCrc32: true,
      });
      for await (const entry of reader) {
        const stream = entry.readable();
        const data = await collectStream(stream);
        expect(data.length).toBe(content.length);
      }
    });
  });

  describe("entry size validation", () => {
    it("detects too many bytes in stored entry", async () => {
      const content = new TextEncoder().encode("Hello!");
      const zip = buildZip("test.txt", content);
      const view = new DataView(zip.buffer);
      const eocdOffset = zip.length - 22;
      const cdOffset = view.getUint32(eocdOffset + 16, true);

      // Set uncompressed size in CD smaller than actual
      view.setUint32(cdOffset + 24, 3, true);

      const reader = await ZipReader.from(new BufferSource(zip), {
        skipCrc32: true,
      });
      for await (const entry of reader) {
        const stream = entry.readable();
        await expect(collectStream(stream)).rejects.toThrow(
          "Too many bytes in the stream",
        );
      }
    });
  });

  describe("EOCD comment", () => {
    it("reads ZIP with EOCD comment", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content);

      // Append a comment to the EOCD
      const comment = new TextEncoder().encode("Hello comment");
      const withComment = new Uint8Array(zip.length + comment.length);
      withComment.set(zip);
      withComment.set(comment, zip.length);

      // Update comment length in EOCD
      const eocdOffset = zip.length - 22;
      const view = new DataView(withComment.buffer);
      view.setUint16(eocdOffset + 20, comment.length, true);

      const reader = await ZipReader.from(new BufferSource(withComment));
      expect(reader.comment).toBeTruthy();
    });
  });

  describe("unsupported compression", () => {
    it("rejects unsupported compression method when decompress requested", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content);
      const view = new DataView(zip.buffer);

      // Set compression method to something unsupported (e.g., 9 = deflate64)
      const eocdOffset = zip.length - 22;
      const cdOffset = view.getUint32(eocdOffset + 16, true);
      view.setUint16(cdOffset + 10, 9, true); // compression method in CDH

      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        expect(entry.isCompressed).toBe(true);
        expect(() => entry.readable()).toThrow(
          "Unsupported compression method",
        );
      }
    });
  });

  describe("multiple entries", () => {
    it("reads ZIP with multiple entries correctly", async () => {
      const encoder = new TextEncoder();
      const file1 = encoder.encode("Hello");
      const file2 = encoder.encode("World!!!");
      const name1 = encoder.encode("a.txt");
      const name2 = encoder.encode("b.txt");
      const crc1 = crc32(file1);
      const crc2 = crc32(file2);

      // LFH 1
      const lfh1 = new Uint8Array(30 + name1.length);
      const lfh1v = new DataView(lfh1.buffer);
      lfh1v.setUint32(0, 0x04034b50, true);
      lfh1v.setUint16(4, 20, true);
      lfh1v.setUint16(12, 0x5421, true);
      lfh1v.setUint32(14, crc1, true);
      lfh1v.setUint32(18, file1.length, true);
      lfh1v.setUint32(22, file1.length, true);
      lfh1v.setUint16(26, name1.length, true);
      lfh1.set(name1, 30);

      // LFH 2
      const lfh2Offset = lfh1.length + file1.length;
      const lfh2 = new Uint8Array(30 + name2.length);
      const lfh2v = new DataView(lfh2.buffer);
      lfh2v.setUint32(0, 0x04034b50, true);
      lfh2v.setUint16(4, 20, true);
      lfh2v.setUint16(12, 0x5421, true);
      lfh2v.setUint32(14, crc2, true);
      lfh2v.setUint32(18, file2.length, true);
      lfh2v.setUint32(22, file2.length, true);
      lfh2v.setUint16(26, name2.length, true);
      lfh2.set(name2, 30);

      const cdOffset = lfh2Offset + lfh2.length + file2.length;

      // CDH 1
      const cdh1 = new Uint8Array(46 + name1.length);
      const cdh1v = new DataView(cdh1.buffer);
      cdh1v.setUint32(0, 0x02014b50, true);
      cdh1v.setUint16(4, 45, true);
      cdh1v.setUint16(6, 20, true);
      cdh1v.setUint16(14, 0x5421, true);
      cdh1v.setUint32(16, crc1, true);
      cdh1v.setUint32(20, file1.length, true);
      cdh1v.setUint32(24, file1.length, true);
      cdh1v.setUint16(28, name1.length, true);
      cdh1v.setUint32(42, 0, true); // offset
      cdh1.set(name1, 46);

      // CDH 2
      const cdh2 = new Uint8Array(46 + name2.length);
      const cdh2v = new DataView(cdh2.buffer);
      cdh2v.setUint32(0, 0x02014b50, true);
      cdh2v.setUint16(4, 45, true);
      cdh2v.setUint16(6, 20, true);
      cdh2v.setUint16(14, 0x5421, true);
      cdh2v.setUint32(16, crc2, true);
      cdh2v.setUint32(20, file2.length, true);
      cdh2v.setUint32(24, file2.length, true);
      cdh2v.setUint16(28, name2.length, true);
      cdh2v.setUint32(42, lfh2Offset, true); // offset
      cdh2.set(name2, 46);

      // EOCD
      const eocd = new Uint8Array(22);
      const eocdv = new DataView(eocd.buffer);
      eocdv.setUint32(0, 0x06054b50, true);
      eocdv.setUint16(8, 2, true);
      eocdv.setUint16(10, 2, true);
      eocdv.setUint32(12, cdh1.length + cdh2.length, true);
      eocdv.setUint32(16, cdOffset, true);

      const total =
        lfh1.length +
        file1.length +
        lfh2.length +
        file2.length +
        cdh1.length +
        cdh2.length +
        eocd.length;
      const zip = new Uint8Array(total);
      let off = 0;
      for (const part of [lfh1, file1, lfh2, file2, cdh1, cdh2, eocd]) {
        zip.set(part, off);
        off += part.length;
      }

      const reader = await ZipReader.from(new BufferSource(zip));
      const entries: ZipEntry[] = [];
      for await (const entry of reader) {
        entries.push(entry);
      }

      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe("a.txt");
      expect(entries[1].name).toBe("b.txt");

      const data1 = await collectStream(entries[0].readable());
      const data2 = await collectStream(entries[1].readable());
      expect(data1).toEqual(file1);
      expect(data2).toEqual(file2);
    });
  });

  describe("ZIP bomb: overlapping file data", () => {
    interface CdRecord {
      name: string;
      offset: number;
      compressedSize: number;
      uncompressedSize: number;
      crc32: number;
      method?: number;
      /** Write sizes and offset via a ZIP64 extra field */
      zip64?: boolean;
    }

    /** Build a ZIP from a raw file-data region and explicit CD records. */
    function buildZipFromRecords(
      fileData: Uint8Array,
      records: CdRecord[],
    ): Uint8Array<ArrayBuffer> {
      const encoder = new TextEncoder();
      const cdhs = records.map((r) => {
        const name = encoder.encode(r.name);
        const extra = new Uint8Array(r.zip64 ? 28 : 0);
        const cdh = new Uint8Array(46 + name.length + extra.length);
        const v = new DataView(cdh.buffer);
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 45, true);
        v.setUint16(6, 20, true);
        v.setUint16(10, r.method ?? 0, true);
        v.setUint16(14, 0x5421, true);
        v.setUint32(16, r.crc32, true);
        v.setUint16(28, name.length, true);
        v.setUint16(30, extra.length, true);
        if (r.zip64) {
          v.setUint32(20, 0xffffffff, true);
          v.setUint32(24, 0xffffffff, true);
          v.setUint32(42, 0xffffffff, true);
          const ev = new DataView(extra.buffer);
          ev.setUint16(0, 0x0001, true);
          ev.setUint16(2, 24, true);
          ev.setBigUint64(4, BigInt(r.uncompressedSize), true);
          ev.setBigUint64(12, BigInt(r.compressedSize), true);
          ev.setBigUint64(20, BigInt(r.offset), true);
        } else {
          v.setUint32(20, r.compressedSize, true);
          v.setUint32(24, r.uncompressedSize, true);
          v.setUint32(42, r.offset, true);
        }
        cdh.set(name, 46);
        cdh.set(extra, 46 + name.length);
        return cdh;
      });
      const cdSize = cdhs.reduce((n, c) => n + c.length, 0);
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, records.length, true);
      ev.setUint16(10, records.length, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, fileData.length, true);

      const zip = new Uint8Array(fileData.length + cdSize + eocd.length);
      let off = 0;
      for (const part of [fileData, ...cdhs, eocd]) {
        zip.set(part, off);
        off += part.length;
      }
      return zip;
    }

    /** Local File Header + name for a stored entry */
    function buildStoredLfh(name: string, data: Uint8Array): Uint8Array {
      const nameBytes = new TextEncoder().encode(name);
      const lfh = new Uint8Array(30 + nameBytes.length);
      const v = new DataView(lfh.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(12, 0x5421, true);
      v.setUint32(14, crc32(data), true);
      v.setUint32(18, data.length, true);
      v.setUint32(22, data.length, true);
      v.setUint16(26, nameBytes.length, true);
      lfh.set(nameBytes, 30);
      return lfh;
    }

    function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    }

    function storedRecord(
      name: string,
      offset: number,
      data: Uint8Array,
    ): CdRecord {
      return {
        name,
        offset,
        compressedSize: data.length,
        uncompressedSize: data.length,
        crc32: crc32(data),
      };
    }

    async function iterate(zip: Uint8Array<ArrayBuffer>, options = {}) {
      const reader = await ZipReader.from(new BufferSource(zip), options);
      const entries: ZipEntry[] = [];
      for await (const entry of reader) entries.push(entry);
      return entries;
    }

    const content = new TextEncoder().encode("Hello");
    const storedData = concat([buildStoredLfh("a.txt", content), content]);

    it("rejects entries that share a local file header by default", async () => {
      const zip = buildZipFromRecords(storedData, [
        storedRecord("a.txt", 0, content),
        storedRecord("b.txt", 0, content),
      ]);
      const error = await iterate(zip).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DuplicateLocalFileHeader);
      expect(error).toMatchObject({
        code: "DUPLICATE_LOCAL_FILE_HEADER",
        message: expect.stringContaining(
          "Duplicate local file header offset detected for entry b.txt",
        ),
      });
    });

    it("still honours the deprecated skipUniqueEntryCheck option", async () => {
      const zip = buildZipFromRecords(storedData, [
        storedRecord("a.txt", 0, content),
        storedRecord("b.txt", 0, content),
      ]);
      const entries = await iterate(zip, {
        skipUniqueEntryCheck: true,
        allowAliasedEntries: undefined,
      });
      expect(entries).toHaveLength(2);
      await expect(
        iterate(zip, {
          skipUniqueEntryCheck: true,
          allowAliasedEntries: false,
        }),
      ).rejects.toThrow(DuplicateLocalFileHeader);
    });

    it("allows exact aliases when allowAliasedEntries is true", async () => {
      // Ten aliases of a 5-byte file: their declared sizes add up to far more
      // than the archive holds, but they all read the same bytes
      const records = Array.from({ length: 10 }, (_, i) =>
        storedRecord(`${i}.txt`, 0, content),
      );
      const zip = buildZipFromRecords(storedData, records);
      const entries = await iterate(zip, { allowAliasedEntries: true });
      expect(entries.map((e) => e.name)).toEqual(records.map((r) => r.name));
      for (const entry of entries) {
        expect(await collectStream(entry.readable())).toEqual(content);
      }
    });

    it.each([
      { compressedSize: 4 },
      { uncompressedSize: 6 },
      { crc32: 0 },
      { method: 8 },
    ])("rejects aliases that disagree on %o", async (change) => {
      const zip = buildZipFromRecords(storedData, [
        storedRecord("a.txt", 0, content),
        { ...storedRecord("b.txt", 0, content), ...change },
      ]);
      await expect(iterate(zip, { allowAliasedEntries: true })).rejects.toThrow(
        EntryAliasMismatch,
      );
    });

    it("rejects entries whose data contains other entries' headers", async () => {
      // c's data is the tail of b's data, which is the tail of a's data.
      // Each entry is individually valid, so a naive reader extracts all three,
      // and the same layout with deflate streams is the overlapping ZIP bomb.
      const tail = new TextEncoder().encode("payload");
      const dataB = concat([buildStoredLfh("c", tail), tail]);
      const lfhB = buildStoredLfh("b", dataB);
      const dataA = concat([lfhB, dataB]);
      const lfhA = buildStoredLfh("a", dataA);
      const fileData = concat([lfhA, dataA]);
      const offsetB = lfhA.length;
      const offsetC = offsetB + lfhB.length;
      const records = [
        storedRecord("a", 0, dataA),
        storedRecord("b", offsetB, dataB),
        storedRecord("c", offsetC, tail),
      ];
      const zip = buildZipFromRecords(fileData, records);
      await expect(iterate(zip)).rejects.toThrow(OverlappingFileData);
      await expect(iterate(zip, { allowAliasedEntries: true })).rejects.toThrow(
        OverlappingFileData,
      );
    });

    it("rejects entries before reading them, based on declared sizes", async () => {
      // Distinct offsets whose compressed sizes cannot all fit before the
      // Central Directory: detected during iteration, without touching data
      const fileData = concat([
        buildStoredLfh("a", content),
        content,
        buildStoredLfh("b", content),
        content,
      ]);
      const zip = buildZipFromRecords(fileData, [
        storedRecord("a", 0, content),
        { ...storedRecord("b", 35, content), compressedSize: 100 },
      ]);
      const reader = await ZipReader.from(new BufferSource(zip));
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const entry of reader) seen.push(entry.name);
        })(),
      ).rejects.toMatchObject({
        code: "OVERLAPPING_FILE_DATA",
        message: expect.stringContaining("at entry b"),
      });
      expect(seen).toEqual(["a"]);
    });

    it("checks sizes and offsets resolved from ZIP64 extra fields", async () => {
      const b = new TextEncoder().encode("World");
      const lfhA = buildStoredLfh("a", content);
      const fileData = concat([lfhA, content, buildStoredLfh("b", b), b]);
      const recordB = {
        ...storedRecord("b", lfhA.length + content.length, b),
        zip64: true,
      };
      const ok = buildZipFromRecords(fileData, [
        storedRecord("a", 0, content),
        recordB,
      ]);
      const entries = await iterate(ok);
      expect(entries[1].zip64).toBe(true);
      expect(await collectStream(entries[1].readable())).toEqual(b);

      const overflowing = buildZipFromRecords(fileData, [
        storedRecord("a", 0, content),
        { ...recordB, compressedSize: 100 },
      ]);
      await expect(iterate(overflowing)).rejects.toThrow(OverlappingFileData);

      const aliased = buildZipFromRecords(fileData, [
        storedRecord("a", 0, content),
        { ...storedRecord("c", 0, content), zip64: true },
      ]);
      await expect(iterate(aliased)).rejects.toThrow(DuplicateLocalFileHeader);
      expect(
        await iterate(aliased, { allowAliasedEntries: true }),
      ).toHaveLength(2);
    });

    it("accepts adjacent non-overlapping entries", async () => {
      const b = new TextEncoder().encode("World");
      const lfhA = buildStoredLfh("a", content);
      const lfhB = buildStoredLfh("b", b);
      const fileData = concat([lfhA, content, lfhB, b]);
      const zip = buildZipFromRecords(fileData, [
        storedRecord("a", 0, content),
        storedRecord("b", lfhA.length + content.length, b),
      ]);
      const entries = await iterate(zip);
      expect(await collectStream(entries[1].readable())).toEqual(b);
    });
  });

  describe("decompression", () => {
    /** One deflated entry with the given compressed bytes and declared sizes */
    function buildDeflatedZip(
      name: string,
      compressed: Uint8Array,
      uncompressedSize: number,
      crc = 0,
    ): Uint8Array<ArrayBuffer> {
      const nameBytes = new TextEncoder().encode(name);
      const lfh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lfh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, 8, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, compressed.length, true);
      lv.setUint32(22, uncompressedSize, true);
      lv.setUint16(26, nameBytes.length, true);
      lfh.set(nameBytes, 30);

      const cdh = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cdh.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 45, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, 8, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, compressed.length, true);
      cv.setUint32(24, uncompressedSize, true);
      cv.setUint16(28, nameBytes.length, true);
      cdh.set(nameBytes, 46);

      const cdOffset = lfh.length + compressed.length;
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, 1, true);
      ev.setUint16(10, 1, true);
      ev.setUint32(12, cdh.length, true);
      ev.setUint32(16, cdOffset, true);

      const zip = new Uint8Array(cdOffset + cdh.length + eocd.length);
      zip.set(lfh, 0);
      zip.set(compressed, lfh.length);
      zip.set(cdh, cdOffset);
      zip.set(eocd, cdOffset + cdh.length);
      return zip;
    }

    async function firstEntry(
      source: RandomAccessSource,
      options = {},
    ): Promise<ZipEntry> {
      const reader = await ZipReader.from(source, options);
      for await (const entry of reader) return entry;
      throw new Error("no entries");
    }

    it("names the entry when deflate data is corrupt", async () => {
      const zip = buildDeflatedZip("bad.bin", new Uint8Array([0xff, 0xff]), 10);
      const entry = await firstEntry(new BufferSource(zip));
      const error = await collectStream(entry.readable()).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DecompressionFailed);
      expect(error).toMatchObject({
        code: "DECOMPRESSION_FAILED",
        message: expect.stringContaining("Failed to decompress entry bad.bin"),
      });
      expect((error as Error).cause).toBeDefined();
    });

    it("names the entry when deflate data is empty", async () => {
      const zip = buildDeflatedZip("empty.bin", new Uint8Array(0), 10);
      const entry = await firstEntry(new BufferSource(zip));
      await expect(collectStream(entry.readable())).rejects.toMatchObject({
        code: "DECOMPRESSION_FAILED",
        message: expect.stringMatching(
          /^Failed to decompress entry empty\.bin: .+/,
        ),
      });
    });

    it("passes errors from before decompression through unchanged", async () => {
      const compressed = await deflateRawZeros(1000);
      const zip = buildDeflatedZip("a.bin", compressed, 1000);
      new DataView(zip.buffer).setUint32(0, 0, true);
      const entry = await firstEntry(new BufferSource(zip));
      const error = await collectStream(entry.readable()).catch(
        (e: unknown) => e,
      );
      expect(error).not.toBeInstanceOf(DecompressionFailed);
      expect((error as Error).message).toBe(
        "Invalid Local File Header signature",
      );
    });

    it("stops at an understated size without delivering the excess", async () => {
      // 512 MiB of zeros in ~510 KiB, declared as 1 MiB
      const compressed = await deflateRawZeros(512 << 20);
      const declared = 1 << 20;
      const zip = buildDeflatedZip("bomb.bin", compressed, declared);
      const entry = await firstEntry(new BufferSource(zip), {
        skipCrc32: true,
      });

      const reader = entry.readable().getReader();
      let delivered = 0;
      const error = await (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return undefined;
          delivered += value.byteLength;
        }
      })().catch((e: unknown) => e);

      expect((error as Error).message).toMatch("Too many bytes in the stream");
      expect(delivered).toBeLessThanOrEqual(declared);
    }, 30_000);

    it("bounds the size of a single decompressed chunk", async () => {
      const total = 64 << 20;
      const compressed = await deflateRawZeros(total);
      const zip = buildDeflatedZip("zeros.bin", compressed, total);
      const entry = await firstEntry(new BufferSource(zip), {
        skipCrc32: true,
      });
      const reader = entry.readable().getReader();
      let largestChunk = 0;
      for (let i = 0; i < 8; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        largestChunk = Math.max(largestChunk, value.byteLength);
      }
      await reader.cancel();
      // At most 16 KiB written at a time, at deflate's ~1032:1 maximum ratio
      expect(largestChunk).toBeLessThanOrEqual(1032 * 16384);
    }, 30_000);
  });

  describe("source closure lifecycle", () => {
    /** A BufferSource wrapper that tracks closure and blocks reads after close. */
    class ClosableBufferSource implements RandomAccessSource {
      readonly #inner: BufferSource;
      #closed = false;

      constructor(data: Uint8Array<ArrayBuffer>) {
        this.#inner = new BufferSource(data);
      }
      get size() {
        return this.#inner.size;
      }
      async read(
        offset: number,
        length: number,
      ): Promise<Uint8Array<ArrayBuffer>> {
        if (this.#closed) throw new Error("Source is closed");
        return this.#inner.read(offset, length);
      }
      async close(): Promise<void> {
        this.#closed = true;
      }
    }

    it("entry.readable() stream errors when source is closed before reading", async () => {
      const zip = buildZip("test.txt", new TextEncoder().encode("hello"));
      const source = new ClosableBufferSource(zip);
      const reader = await ZipReader.from(source);

      // Collect entries without reading their content
      const entries: ZipEntry[] = [];
      for await (const entry of reader) {
        entries.push(entry);
      }

      // Close the source directly — the consumer's responsibility
      await source.close();

      // Now try to read an entry stream — the source is closed
      const stream = entries[0].readable();
      await expect(collectStream(stream)).rejects.toThrow("Source is closed");
    });

    it("source closed externally mid-iteration propagates error from iterator", async () => {
      // Build a zip with two entries so the iterator makes more than one read
      const encoder = new TextEncoder();
      const file1 = encoder.encode("Hello");
      const file2 = encoder.encode("World");
      const name1 = encoder.encode("a.txt");
      const name2 = encoder.encode("b.txt");

      function localCrc32(data: Uint8Array): number {
        let crc = ~0;
        for (let i = 0; i < data.length; i++) {
          crc ^= data[i];
          for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ ((crc & 1) * 0xedb88320);
          }
        }
        return ~crc >>> 0;
      }

      const crc1 = localCrc32(file1);
      const crc2 = localCrc32(file2);

      const lfh1 = new Uint8Array(30 + name1.length);
      const lv1 = new DataView(lfh1.buffer);
      lv1.setUint32(0, 0x04034b50, true);
      lv1.setUint16(4, 20, true);
      lv1.setUint32(14, crc1, true);
      lv1.setUint32(18, file1.length, true);
      lv1.setUint32(22, file1.length, true);
      lv1.setUint16(26, name1.length, true);
      lfh1.set(name1, 30);

      const lfh2Offset = lfh1.length + file1.length;
      const lfh2 = new Uint8Array(30 + name2.length);
      const lv2 = new DataView(lfh2.buffer);
      lv2.setUint32(0, 0x04034b50, true);
      lv2.setUint16(4, 20, true);
      lv2.setUint32(14, crc2, true);
      lv2.setUint32(18, file2.length, true);
      lv2.setUint32(22, file2.length, true);
      lv2.setUint16(26, name2.length, true);
      lfh2.set(name2, 30);

      const cdOffset = lfh2Offset + lfh2.length + file2.length;

      const cdh1 = new Uint8Array(46 + name1.length);
      const cv1 = new DataView(cdh1.buffer);
      cv1.setUint32(0, 0x02014b50, true);
      cv1.setUint16(4, 45, true);
      cv1.setUint16(6, 20, true);
      cv1.setUint32(16, crc1, true);
      cv1.setUint32(20, file1.length, true);
      cv1.setUint32(24, file1.length, true);
      cv1.setUint16(28, name1.length, true);
      cv1.setUint32(42, 0, true);
      cdh1.set(name1, 46);

      const cdh2 = new Uint8Array(46 + name2.length);
      const cv2 = new DataView(cdh2.buffer);
      cv2.setUint32(0, 0x02014b50, true);
      cv2.setUint16(4, 45, true);
      cv2.setUint16(6, 20, true);
      cv2.setUint32(16, crc2, true);
      cv2.setUint32(20, file2.length, true);
      cv2.setUint32(24, file2.length, true);
      cv2.setUint16(28, name2.length, true);
      cv2.setUint32(42, lfh2Offset, true);
      cdh2.set(name2, 46);

      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, 2, true);
      ev.setUint16(10, 2, true);
      ev.setUint32(12, cdh1.length + cdh2.length, true);
      ev.setUint32(16, cdOffset, true);

      const total =
        lfh1.length +
        file1.length +
        lfh2.length +
        file2.length +
        cdh1.length +
        cdh2.length +
        eocd.length;
      const zip = new Uint8Array(total);
      let off = 0;
      for (const part of [lfh1, file1, lfh2, file2, cdh1, cdh2, eocd]) {
        zip.set(part, off);
        off += part.length;
      }

      // Source that closes after one read (simulates external closure)
      let readCount = 0;
      const source: RandomAccessSource = {
        size: zip.length,
        async read(offset, length) {
          readCount++;
          if (readCount > 1) throw new Error("Source is closed");
          return new BufferSource(zip).read(offset, length);
        },
      };

      const reader = await ZipReader.from(source);
      await expect(
        (async () => {
          for await (const _entry of reader) {
            // The second CD chunk read will fail
          }
        })(),
      ).rejects.toThrow("Source is closed");
    });

    describe.skipIf(isBrowser)("FileSource closure", () => {
      let tmpFile: string;

      async function createTmpZip(): Promise<string> {
        const { writeFile } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const zip = buildZip("test.txt", new TextEncoder().encode("hello"));
        const path = join(
          tmpdir(),
          `zip-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
        );
        await writeFile(path, zip);
        return path;
      }

      async function cleanup(path: string): Promise<void> {
        const { unlink } = await import("node:fs/promises");
        await unlink(path).catch(() => {});
      }

      it("FileSource.close() is idempotent", async () => {
        const { FileSource } = await import("../src/sources/file.js");
        tmpFile = await createTmpZip();
        try {
          const source = await FileSource.open(tmpFile);
          await source.close();
          await source.close(); // should not throw
        } finally {
          await cleanup(tmpFile);
        }
      });

      it("FileSource.read() after close() throws 'Source is closed'", async () => {
        const { FileSource } = await import("../src/sources/file.js");
        tmpFile = await createTmpZip();
        try {
          const source = await FileSource.open(tmpFile);
          await source.close();
          await expect(source.read(0, 4)).rejects.toThrow("Source is closed");
        } finally {
          await cleanup(tmpFile);
        }
      });

      it("ZipReader.from() fails gracefully when FileSource is closed before parsing", async () => {
        const { FileSource } = await import("../src/sources/file.js");
        tmpFile = await createTmpZip();
        try {
          const source = await FileSource.open(tmpFile);
          await source.close();
          await expect(ZipReader.from(source)).rejects.toThrow(
            "Source is closed",
          );
        } finally {
          await cleanup(tmpFile);
        }
      });

      it("iteration fails gracefully when FileSource is closed after from()", async () => {
        const { FileSource } = await import("../src/sources/file.js");
        tmpFile = await createTmpZip();
        try {
          const source = await FileSource.open(tmpFile);
          const reader = await ZipReader.from(source);
          await source.close(); // close externally after reader is created
          await expect(
            (async () => {
              for await (const _entry of reader) {
                // CD read should fail
              }
            })(),
          ).rejects.toThrow("Source is closed");
        } finally {
          await cleanup(tmpFile);
        }
      });

      it("entry stream fails gracefully when FileSource is closed before reading", async () => {
        const { FileSource } = await import("../src/sources/file.js");
        tmpFile = await createTmpZip();
        try {
          const source = await FileSource.open(tmpFile);
          const reader = await ZipReader.from(source);
          const entries: ZipEntry[] = [];
          for await (const entry of reader) {
            entries.push(entry);
          }
          await source.close(); // consumer closes the source directly
          const stream = entries[0].readable();
          await expect(collectStream(stream)).rejects.toThrow(
            "Source is closed",
          );
        } finally {
          await cleanup(tmpFile);
        }
      });
    });
  });

  describe("immutability", () => {
    it("ZipReader.comment cannot be mutated", async () => {
      const zip = buildZip("test.txt", new TextEncoder().encode("hello"));
      const reader = await ZipReader.from(new BufferSource(zip));
      expect(() => {
        (reader as any).comment = "hacked";
      }).toThrow();
      expect(reader.comment).toBe("");
    });

    it("ZipReader.isZip64 cannot be mutated", async () => {
      const zip = buildZip("test.txt", new TextEncoder().encode("hello"));
      const reader = await ZipReader.from(new BufferSource(zip));
      expect(() => {
        (reader as any).isZip64 = true;
      }).toThrow();
      expect(reader.isZip64).toBe(false);
    });

    it("ZipEntry properties cannot be mutated", async () => {
      const zip = buildZip("test.txt", new TextEncoder().encode("hello"));
      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        expect(() => {
          (entry as any).name = "hacked";
        }).toThrow();
        expect(() => {
          (entry as any).compressedSize = 999;
        }).toThrow();
        expect(() => {
          (entry as any).uncompressedSize = 999;
        }).toThrow();
        expect(() => {
          (entry as any).crc32 = 0;
        }).toThrow();
        expect(() => {
          (entry as any).compressionMethod = 8;
        }).toThrow();
        expect(() => {
          (entry as any).isDirectory = true;
        }).toThrow();
        expect(() => {
          (entry as any).isCompressed = true;
        }).toThrow();
        expect(() => {
          (entry as any).isEncrypted = true;
        }).toThrow();
        expect(() => {
          (entry as any).zip64 = true;
        }).toThrow();
        expect(() => {
          (entry as any).externalAttributes = 999;
        }).toThrow();
        expect(() => {
          (entry as any).versionMadeBy = 999;
        }).toThrow();
        expect(() => {
          (entry as any).generalPurposeBitFlag = 999;
        }).toThrow();
        expect(() => {
          (entry as any).comment = "hacked";
        }).toThrow();
        expect(() => {
          (entry as any).lastModified = new Date();
        }).toThrow();
        expect(() => {
          (entry as any).extraFields = [];
        }).toThrow();
        expect(entry.name).toBe("test.txt");
      }
    });

    it("ZipEntry.lastModified mutation does not affect entry", async () => {
      const zip = buildZip("test.txt", new TextEncoder().encode("hello"));
      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        const date1 = entry.lastModified;
        date1.setFullYear(1999);
        const date2 = entry.lastModified;
        expect(date2.getFullYear()).not.toBe(1999);
        // Each access returns a new Date instance
        expect(date2).not.toBe(date1);
      }
    });

    it("ZipEntry.extraFields data mutation does not affect entry", async () => {
      const extraField = new Uint8Array([0x99, 0x99, 4, 0, 1, 2, 3, 4]);
      const zip = buildZip("test.txt", new TextEncoder().encode("hello"), {
        cdhExtraField: extraField,
      });
      const reader = await ZipReader.from(new BufferSource(zip));
      for await (const entry of reader) {
        const fields1 = entry.extraFields;
        expect(fields1.length).toBe(1);
        // Mutate the returned data
        fields1[0].data[0] = 0xff;
        // Next access should return fresh data
        const fields2 = entry.extraFields;
        expect(fields2[0].data[0]).not.toBe(0xff);
        expect(fields2[0].data[0]).toBe(1);
        // Each access returns a new array
        expect(fields2).not.toBe(fields1);
      }
    });
  });
});
