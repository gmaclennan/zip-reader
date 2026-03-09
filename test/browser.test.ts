import { describe, it, expect } from "vitest";
import { ZipReader, ZipEntry } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { BlobSource } from "../src/sources/blob.js";
import { crc32 } from "#crc32";

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

/**
 * Create a minimal valid ZIP file with one stored (uncompressed) entry.
 * This builds the ZIP manually to avoid depending on any external tools.
 */
function createTestZip(
  filename: string,
  content: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(filename);
  const crc = crc32(content);

  // Local File Header (30 + nameLen)
  const lfh = new Uint8Array(30 + nameBytes.length);
  const lfhView = new DataView(lfh.buffer);
  lfhView.setUint32(0, 0x04034b50, true); // signature
  lfhView.setUint16(4, 20, true); // version needed
  lfhView.setUint16(6, 0, true); // flags
  lfhView.setUint16(8, 0, true); // compression: store
  lfhView.setUint16(10, 0, true); // mod time
  lfhView.setUint16(12, 0x5421, true); // mod date (2022-01-01)
  lfhView.setUint32(14, crc, true); // crc32
  lfhView.setUint32(18, content.length, true); // compressed size
  lfhView.setUint32(22, content.length, true); // uncompressed size
  lfhView.setUint16(26, nameBytes.length, true); // filename length
  lfhView.setUint16(28, 0, true); // extra field length
  lfh.set(nameBytes, 30);

  // Central Directory Header (46 + nameLen)
  const cdh = new Uint8Array(46 + nameBytes.length);
  const cdhView = new DataView(cdh.buffer);
  cdhView.setUint32(0, 0x02014b50, true); // signature
  cdhView.setUint16(4, 45, true); // version made by
  cdhView.setUint16(6, 20, true); // version needed
  cdhView.setUint16(8, 0, true); // flags
  cdhView.setUint16(10, 0, true); // compression: store
  cdhView.setUint16(12, 0, true); // mod time
  cdhView.setUint16(14, 0x5421, true); // mod date
  cdhView.setUint32(16, crc, true); // crc32
  cdhView.setUint32(20, content.length, true); // compressed size
  cdhView.setUint32(24, content.length, true); // uncompressed size
  cdhView.setUint16(28, nameBytes.length, true); // filename length
  cdhView.setUint16(30, 0, true); // extra field length
  cdhView.setUint16(32, 0, true); // comment length
  cdhView.setUint16(34, 0, true); // disk number start
  cdhView.setUint16(36, 0, true); // internal attrs
  cdhView.setUint32(38, 0, true); // external attrs
  cdhView.setUint32(42, 0, true); // offset of local header
  cdh.set(nameBytes, 46);

  // End of Central Directory Record (22 bytes)
  const cdOffset = lfh.length + content.length;
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // signature
  eocdView.setUint16(4, 0, true); // disk number
  eocdView.setUint16(6, 0, true); // disk number of CD
  eocdView.setUint16(8, 1, true); // entries on this disk
  eocdView.setUint16(10, 1, true); // total entries
  eocdView.setUint32(12, cdh.length, true); // CD size
  eocdView.setUint32(16, cdOffset, true); // CD offset
  eocdView.setUint16(20, 0, true); // comment length

  // Concatenate all parts
  const total = lfh.length + content.length + cdh.length + eocd.length;
  const zip = new Uint8Array(new ArrayBuffer(total));
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

describe("ZipReader (browser-compatible)", () => {
  it("reads a stored file from a manually-created zip", async () => {
    const content = new TextEncoder().encode("Hello, World!");
    const zipData = createTestZip("hello.txt", content);

    const zip = await ZipReader.from(new BufferSource(zipData));
    expect(zip.comment).toBe("");
    expect(zip.isZip64).toBe(false);

    const entries: ZipEntry[] = [];
    for await (const entry of zip) {
      entries.push(entry);
    }
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("hello.txt");
    expect(entries[0].isCompressed).toBe(false);
    expect(entries[0].isDirectory).toBe(false);

    const stream = entries[0].readable();
    const result = await collectStream(stream);
    expect(result).toEqual(content);
  });

  it("validates CRC32 correctly", async () => {
    const content = new TextEncoder().encode("Test content");
    const zipData = createTestZip("test.txt", content);

    // Corrupt one byte of file data
    zipData[30 + 8 + 2] ^= 0xff; // flip a byte in the content

    const zip = await ZipReader.from(new BufferSource(zipData));
    for await (const entry of zip) {
      const stream = entry.readable({ validateCrc32: true });
      await expect(collectStream(stream)).rejects.toThrow(
        "CRC32 validation failed",
      );
    }
  });

  it("reads entry properties correctly", async () => {
    const content = new TextEncoder().encode("Hello");
    const zipData = createTestZip("dir/file.txt", content);

    const zip = await ZipReader.from(new BufferSource(zipData));
    for await (const entry of zip) {
      expect(entry.name).toBe("dir/file.txt");
      expect(entry.compressedSize).toBe(content.length);
      expect(entry.uncompressedSize).toBe(content.length);
      expect(entry.isEncrypted).toBe(false);
      expect(entry.compressionMethod).toBe(0);
    }
  });

  it("reads from Blob", async () => {
    const content = new TextEncoder().encode("Blob test");
    const zipData = createTestZip("blob.txt", content);

    const blob = new Blob([zipData]);
    const zip = await ZipReader.from(new BlobSource(blob));

    expect(zip.comment).toBe("");

    const entries: ZipEntry[] = [];
    for await (const entry of zip) {
      entries.push(entry);
    }
    expect(entries.length).toBe(1);

    const stream = entries[0].readable();
    const result = await collectStream(stream);
    expect(result).toEqual(content);
  });

  it("handles empty zip", async () => {
    // Create a minimal empty ZIP (just EOCD)
    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    view.setUint32(0, 0x06054b50, true);
    // All other fields are 0 (no entries, no CD)

    const zip = await ZipReader.from(new BufferSource(eocd));
    const entries: ZipEntry[] = [];
    for await (const entry of zip) {
      entries.push(entry);
    }
    expect(entries.length).toBe(0);
  });

  it("rejects encrypted entries", async () => {
    const content = new TextEncoder().encode("encrypted");
    const zipData = createTestZip("secret.txt", content);
    // Set encrypted flag in CD header
    const cdOffset = 30 + 10 + content.length; // LFH + name + data
    const view = new DataView(zipData.buffer);
    // CDH flags at offset cdOffset + 8
    view.setUint16(cdOffset + 8, 0x1, true); // FLAG_ENCRYPTED

    const zip = await ZipReader.from(new BufferSource(zipData));
    for await (const entry of zip) {
      expect(entry.isEncrypted).toBe(true);
      expect(() => entry.readable()).toThrow("Decryption is not supported");
    }
  });
});
