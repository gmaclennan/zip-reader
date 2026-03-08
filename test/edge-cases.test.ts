import { describe, it, expect } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipReader, ZipEntry } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { FileSource } from "../src/sources/file.js";
import type { RandomAccessSource } from "../src/types.js";

async function collectStream(
  stream: ReadableStream<Uint8Array>
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
  }
): Uint8Array {
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

  const zip = new Uint8Array(lfh.length + content.length + cdh.length + eocd.length);
  let offset = 0;
  zip.set(lfh, offset); offset += lfh.length;
  zip.set(content, offset); offset += content.length;
  zip.set(cdh, offset); offset += cdh.length;
  zip.set(eocd, offset);

  return zip;
}

/** Build a minimal empty ZIP (just EOCD, 0 entries) */
function buildEmptyZip(): Uint8Array {
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  return eocd;
}

describe("Edge cases and malformed ZIP handling", () => {
  describe("too-small source", () => {
    it("rejects source smaller than EOCD", async () => {
      await expect(
        ZipReader.from(new BufferSource(new Uint8Array(10)))
      ).rejects.toThrow("End of Central Directory Record not found");
    });

    it("rejects empty source", async () => {
      await expect(
        ZipReader.from(new BufferSource(new Uint8Array(0)))
      ).rejects.toThrow("End of Central Directory Record not found");
    });
  });

  describe("EOCD validation", () => {
    it("rejects ZIP with invalid EOCD signature", async () => {
      const data = new Uint8Array(22);
      // Wrong signature
      data[0] = 0x00;
      await expect(
        ZipReader.from(new BufferSource(data))
      ).rejects.toThrow("End of Central Directory Record not found");
    });

    it("rejects multi-disk ZIP", async () => {
      const eocd = new Uint8Array(22);
      const view = new DataView(eocd.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(4, 1, true); // disk number = 1
      await expect(
        ZipReader.from(new BufferSource(eocd))
      ).rejects.toThrow("Multi-disk ZIP files are not supported");
    });

    it("rejects entry count inconsistent with CD size", async () => {
      // Craft a ZIP where entry count is too large for CD size
      const eocd = new Uint8Array(22);
      const view = new DataView(eocd.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, 100, true);  // 100 entries
      view.setUint16(10, 100, true); // 100 total entries
      view.setUint32(12, 46, true);  // CD size = 46 (only fits 1 entry)
      view.setUint32(16, 0, true);   // CD offset = 0

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
      fullView.setUint32(46 + 12, 46, true);  // CD size
      fullView.setUint32(46 + 16, 0, true);    // CD offset

      await expect(
        ZipReader.from(new BufferSource(full))
      ).rejects.toThrow("Entry count is inconsistent with Central Directory size");
    });

    it("rejects CD that extends beyond EOCD", async () => {
      const full = new Uint8Array(22);
      const view = new DataView(full.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, 1, true);
      view.setUint16(10, 1, true);
      view.setUint32(12, 100, true); // CD size much larger than file
      view.setUint32(16, 0, true);   // CD offset = 0

      await expect(
        ZipReader.from(new BufferSource(full))
      ).rejects.toThrow("Central Directory extends beyond End of Central Directory Record");
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
        })()
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
        })()
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
        })()
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
        })()
      ).rejects.toThrow("Absolute path");
    });

    it("rejects directory traversal", async () => {
      const zip = buildZip("../../../etc/passwd", new TextEncoder().encode("test"));
      await expect(
        (async () => {
          const reader = await ZipReader.from(new BufferSource(zip));
          for await (const _entry of reader) {
            // iterate
          }
        })()
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
        })()
      ).rejects.toThrow("Absolute path");
    });

    it("allows sloppy filenames when validation is disabled", async () => {
      const zip = buildZip("dir\\file.txt", new TextEncoder().encode("test"));
      const reader = await ZipReader.from(new BufferSource(zip), {
        validateFilenames: false,
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
        })()
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
          "Invalid Local File Header signature"
        );
      }
    });

    it("rejects file data that overflows into CD", async () => {
      const content = new TextEncoder().encode("test");
      const zip = buildZip("test.txt", content);
      const view = new DataView(zip.buffer);

      // Set compressed size in CD to a value that would overflow
      const eocdOffset = zip.length - 22;
      const cdOffset = view.getUint32(eocdOffset + 16, true);
      // Set compressedSize to something huge in CD header
      view.setUint32(cdOffset + 20, 999999, true);

      const reader = await ZipReader.from(new BufferSource(zip), {
        validateCrc32: false,
        validateEntrySizes: false,
      });
      for await (const entry of reader) {
        const stream = entry.readable();
        await expect(collectStream(stream)).rejects.toThrow(
          "File data overflows file bounds"
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
        const stream = entry.readable({ validateCrc32: true });
        await expect(collectStream(stream)).rejects.toThrow(
          "CRC32 validation failed"
        );
      }
    });

    it("skips CRC32 validation when disabled globally", async () => {
      const content = new TextEncoder().encode("Hello, World!");
      const zip = buildZip("test.txt", content);
      zip[30 + 8 + 2] ^= 0xff; // corrupt data

      const reader = await ZipReader.from(new BufferSource(zip), {
        validateCrc32: false,
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
        validateCrc32: false,
      });
      for await (const entry of reader) {
        const stream = entry.readable();
        await expect(collectStream(stream)).rejects.toThrow(
          "Too many bytes in the stream"
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
        expect(() => entry.readable()).toThrow("Unsupported compression method");
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
        lfh1.length + file1.length + lfh2.length + file2.length +
        cdh1.length + cdh2.length + eocd.length;
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
    it("detects duplicate local file header offsets", async () => {
      // Build a ZIP where two CD entries point to the same LFH offset (offset 0)
      const encoder = new TextEncoder();
      const content = encoder.encode("Hello");
      const name1 = encoder.encode("a.txt");
      const name2 = encoder.encode("b.txt");
      const crc1 = crc32(content);

      // Single LFH + data
      const lfh = new Uint8Array(30 + name1.length);
      const lfhv = new DataView(lfh.buffer);
      lfhv.setUint32(0, 0x04034b50, true);
      lfhv.setUint16(4, 20, true);
      lfhv.setUint16(12, 0x5421, true);
      lfhv.setUint32(14, crc1, true);
      lfhv.setUint32(18, content.length, true);
      lfhv.setUint32(22, content.length, true);
      lfhv.setUint16(26, name1.length, true);
      lfh.set(name1, 30);

      const cdOffset = lfh.length + content.length;

      // CDH 1 - points to offset 0
      const cdh1 = new Uint8Array(46 + name1.length);
      const cdh1v = new DataView(cdh1.buffer);
      cdh1v.setUint32(0, 0x02014b50, true);
      cdh1v.setUint16(4, 45, true);
      cdh1v.setUint16(6, 20, true);
      cdh1v.setUint16(14, 0x5421, true);
      cdh1v.setUint32(16, crc1, true);
      cdh1v.setUint32(20, content.length, true);
      cdh1v.setUint32(24, content.length, true);
      cdh1v.setUint16(28, name1.length, true);
      cdh1v.setUint32(42, 0, true); // offset 0
      cdh1.set(name1, 46);

      // CDH 2 - ALSO points to offset 0 (the bomb technique)
      const cdh2 = new Uint8Array(46 + name2.length);
      const cdh2v = new DataView(cdh2.buffer);
      cdh2v.setUint32(0, 0x02014b50, true);
      cdh2v.setUint16(4, 45, true);
      cdh2v.setUint16(6, 20, true);
      cdh2v.setUint16(14, 0x5421, true);
      cdh2v.setUint32(16, crc1, true);
      cdh2v.setUint32(20, content.length, true);
      cdh2v.setUint32(24, content.length, true);
      cdh2v.setUint16(28, name2.length, true);
      cdh2v.setUint32(42, 0, true); // same offset 0!
      cdh2.set(name2, 46);

      // EOCD
      const eocd = new Uint8Array(22);
      const eocdv = new DataView(eocd.buffer);
      eocdv.setUint32(0, 0x06054b50, true);
      eocdv.setUint16(8, 2, true);
      eocdv.setUint16(10, 2, true);
      eocdv.setUint32(12, cdh1.length + cdh2.length, true);
      eocdv.setUint32(16, cdOffset, true);

      const total = lfh.length + content.length + cdh1.length + cdh2.length + eocd.length;
      const zip = new Uint8Array(total);
      let off = 0;
      for (const part of [lfh, content, cdh1, cdh2, eocd]) {
        zip.set(part, off);
        off += part.length;
      }

      const reader = await ZipReader.from(new BufferSource(zip));
      await expect(
        (async () => {
          for await (const _entry of reader) {
            // iterate
          }
        })()
      ).rejects.toThrow("Duplicate local file header offset detected");
    });

    it("allows duplicate offsets when uniqueEntryOffsets is false", async () => {
      // Same ZIP as above, but with the check disabled
      const encoder = new TextEncoder();
      const content = encoder.encode("Hello");
      const name1 = encoder.encode("a.txt");
      const name2 = encoder.encode("b.txt");
      const crc1 = crc32(content);

      const lfh = new Uint8Array(30 + name1.length);
      const lfhv = new DataView(lfh.buffer);
      lfhv.setUint32(0, 0x04034b50, true);
      lfhv.setUint16(4, 20, true);
      lfhv.setUint16(12, 0x5421, true);
      lfhv.setUint32(14, crc1, true);
      lfhv.setUint32(18, content.length, true);
      lfhv.setUint32(22, content.length, true);
      lfhv.setUint16(26, name1.length, true);
      lfh.set(name1, 30);

      const cdOffset = lfh.length + content.length;

      const cdh1 = new Uint8Array(46 + name1.length);
      const cdh1v = new DataView(cdh1.buffer);
      cdh1v.setUint32(0, 0x02014b50, true);
      cdh1v.setUint16(4, 45, true);
      cdh1v.setUint16(6, 20, true);
      cdh1v.setUint16(14, 0x5421, true);
      cdh1v.setUint32(16, crc1, true);
      cdh1v.setUint32(20, content.length, true);
      cdh1v.setUint32(24, content.length, true);
      cdh1v.setUint16(28, name1.length, true);
      cdh1v.setUint32(42, 0, true);
      cdh1.set(name1, 46);

      const cdh2 = new Uint8Array(46 + name2.length);
      const cdh2v = new DataView(cdh2.buffer);
      cdh2v.setUint32(0, 0x02014b50, true);
      cdh2v.setUint16(4, 45, true);
      cdh2v.setUint16(6, 20, true);
      cdh2v.setUint16(14, 0x5421, true);
      cdh2v.setUint32(16, crc1, true);
      cdh2v.setUint32(20, content.length, true);
      cdh2v.setUint32(24, content.length, true);
      cdh2v.setUint16(28, name2.length, true);
      cdh2v.setUint32(42, 0, true);
      cdh2.set(name2, 46);

      const eocd = new Uint8Array(22);
      const eocdv = new DataView(eocd.buffer);
      eocdv.setUint32(0, 0x06054b50, true);
      eocdv.setUint16(8, 2, true);
      eocdv.setUint16(10, 2, true);
      eocdv.setUint32(12, cdh1.length + cdh2.length, true);
      eocdv.setUint32(16, cdOffset, true);

      const total = lfh.length + content.length + cdh1.length + cdh2.length + eocd.length;
      const zip = new Uint8Array(total);
      let off = 0;
      for (const part of [lfh, content, cdh1, cdh2, eocd]) {
        zip.set(part, off);
        off += part.length;
      }

      const reader = await ZipReader.from(new BufferSource(zip), {
        uniqueEntryOffsets: false,
      });
      const entries: ZipEntry[] = [];
      for await (const entry of reader) {
        entries.push(entry);
      }
      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe("a.txt");
      expect(entries[1].name).toBe("b.txt");

      // Both entries should read the same data
      const data1 = await collectStream(entries[0].readable());
      const data2 = await collectStream(entries[1].readable());
      expect(data1).toEqual(content);
      expect(data2).toEqual(content);
    });
  });

  describe("source closure lifecycle", () => {
    /** A BufferSource wrapper that tracks closure and blocks reads after close. */
    class ClosableBufferSource implements RandomAccessSource {
      readonly #inner: BufferSource;
      #closed = false;

      constructor(data: Uint8Array) {
        this.#inner = new BufferSource(data);
      }
      get size() {
        return this.#inner.size;
      }
      async read(offset: number, length: number): Promise<Uint8Array> {
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
        lfh1.length + file1.length + lfh2.length + file2.length +
        cdh1.length + cdh2.length + eocd.length;
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
        })()
      ).rejects.toThrow("Source is closed");
    });

    describe("FileSource closure", () => {
      let tmpFile: string;

      async function createTmpZip(): Promise<string> {
        const zip = buildZip("test.txt", new TextEncoder().encode("hello"));
        const path = join(tmpdir(), `zip-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
        await writeFile(path, zip);
        return path;
      }

      it("FileSource.close() is idempotent", async () => {
        tmpFile = await createTmpZip();
        try {
          const source = await FileSource.open(tmpFile);
          await source.close();
          await source.close(); // should not throw
        } finally {
          await unlink(tmpFile).catch(() => {});
        }
      });

      it("FileSource.read() after close() throws 'Source is closed'", async () => {
        tmpFile = await createTmpZip();
        try {
          const source = await FileSource.open(tmpFile);
          await source.close();
          await expect(source.read(0, 4)).rejects.toThrow("Source is closed");
        } finally {
          await unlink(tmpFile).catch(() => {});
        }
      });

      it("ZipReader.from() fails gracefully when FileSource is closed before parsing", async () => {
        tmpFile = await createTmpZip();
        try {
          const source = await FileSource.open(tmpFile);
          await source.close();
          await expect(ZipReader.from(source)).rejects.toThrow("Source is closed");
        } finally {
          await unlink(tmpFile).catch(() => {});
        }
      });

      it("iteration fails gracefully when FileSource is closed after from()", async () => {
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
            })()
          ).rejects.toThrow("Source is closed");
        } finally {
          await unlink(tmpFile).catch(() => {});
        }
      });

      it("entry stream fails gracefully when FileSource is closed before reading", async () => {
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
          await expect(collectStream(stream)).rejects.toThrow("Source is closed");
        } finally {
          await unlink(tmpFile).catch(() => {});
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
        expect(() => { (entry as any).name = "hacked"; }).toThrow();
        expect(() => { (entry as any).compressedSize = 999; }).toThrow();
        expect(() => { (entry as any).uncompressedSize = 999; }).toThrow();
        expect(() => { (entry as any).crc32 = 0; }).toThrow();
        expect(() => { (entry as any).compressionMethod = 8; }).toThrow();
        expect(() => { (entry as any).isDirectory = true; }).toThrow();
        expect(() => { (entry as any).isCompressed = true; }).toThrow();
        expect(() => { (entry as any).isEncrypted = true; }).toThrow();
        expect(() => { (entry as any).zip64 = true; }).toThrow();
        expect(() => { (entry as any).externalAttributes = 999; }).toThrow();
        expect(() => { (entry as any).versionMadeBy = 999; }).toThrow();
        expect(() => { (entry as any).generalPurposeBitFlag = 999; }).toThrow();
        expect(() => { (entry as any).comment = "hacked"; }).toThrow();
        expect(() => { (entry as any).lastModified = new Date(); }).toThrow();
        expect(() => { (entry as any).extraFields = []; }).toThrow();
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
