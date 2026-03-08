import { describe, it, expect } from "vitest";
import { ZipReader, ZipEntry } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { BlobSource } from "../src/sources/blob.js";
import { FileSystemFileHandleSource } from "../src/sources/opfs.js";

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
function createTestZip(filename: string, content: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(filename);
  const crc = crc32Simple(content);

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
  const zip = new Uint8Array(total);
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

/** Simple CRC32 for testing */
function crc32Simple(data: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) * 0xedb88320);
    }
  }
  return ~crc >>> 0;
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

// Probe actual OPFS write support (not just API existence) via top-level
// await, which is valid in ESM browser modules. WebKit has partial OPFS
// support: getDirectory() exists but createWritable() may throw or be absent.
const supportsOPFS = await (async () => {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.storage?.getDirectory !== "function"
  )
    return false;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("__vitest_opfs_probe__", {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.close();
    await root.removeEntry("__vitest_opfs_probe__");
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!supportsOPFS)("FileSystemFileHandleSource (OPFS)", () => {
  async function writeToOpfs(
    filename: string,
    data: Uint8Array,
  ): Promise<FileSystemFileHandle> {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    return fileHandle;
  }

  it("reads a stored file from an OPFS FileSystemFileHandle", async () => {
    const content = new TextEncoder().encode("Hello from OPFS!");
    const zipData = createTestZip("hello.txt", content);

    const fileHandle = await writeToOpfs("test-opfs-read.zip", zipData);
    const source = await FileSystemFileHandleSource.open(fileHandle);

    expect(source.size).toBe(zipData.byteLength);

    const zip = await ZipReader.from(source);
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

  it("validates CRC32 for OPFS source", async () => {
    const content = new TextEncoder().encode("CRC32 check");
    const zipData = createTestZip("crc.txt", content);
    // Corrupt a byte in the file content area (after 30-byte LFH + 7-byte name)
    zipData[30 + 7] ^= 0xff;

    const fileHandle = await writeToOpfs("test-opfs-crc.zip", zipData);
    const source = await FileSystemFileHandleSource.open(fileHandle);
    const zip = await ZipReader.from(source);

    for await (const entry of zip) {
      const stream = entry.readable({ validateCrc32: true });
      await expect(collectStream(stream)).rejects.toThrow("CRC32 validation failed");
    }
  });

  it("throws RangeError for out-of-bounds reads", async () => {
    const content = new TextEncoder().encode("small");
    const zipData = createTestZip("s.txt", content);

    const fileHandle = await writeToOpfs("test-opfs-oob.zip", zipData);
    const source = await FileSystemFileHandleSource.open(fileHandle);

    await expect(source.read(0, source.size + 1)).rejects.toThrow(RangeError);
    await expect(source.read(-1, 1)).rejects.toThrow(RangeError);
  });

  it("reads entry properties correctly from OPFS source", async () => {
    const content = new TextEncoder().encode("property check");
    const zipData = createTestZip("dir/file.txt", content);

    const fileHandle = await writeToOpfs("test-opfs-props.zip", zipData);
    const source = await FileSystemFileHandleSource.open(fileHandle);
    const zip = await ZipReader.from(source);

    for await (const entry of zip) {
      expect(entry.name).toBe("dir/file.txt");
      expect(entry.compressedSize).toBe(content.length);
      expect(entry.uncompressedSize).toBe(content.length);
      expect(entry.isEncrypted).toBe(false);
      expect(entry.compressionMethod).toBe(0);
    }
  });

  describe("source closure lifecycle", () => {
    it("close() is idempotent", async () => {
      const content = new TextEncoder().encode("hello");
      const zipData = createTestZip("hello.txt", content);
      const fileHandle = await writeToOpfs("test-opfs-close-idempotent.zip", zipData);
      const source = await FileSystemFileHandleSource.open(fileHandle);
      await source.close();
      await source.close(); // should not throw
    });

    it("read() after close() throws 'Source is closed'", async () => {
      const content = new TextEncoder().encode("hello");
      const zipData = createTestZip("hello.txt", content);
      const fileHandle = await writeToOpfs("test-opfs-close-read.zip", zipData);
      const source = await FileSystemFileHandleSource.open(fileHandle);
      await source.close();
      await expect(source.read(0, 4)).rejects.toThrow("Source is closed");
    });

    it("ZipReader.from() fails gracefully when source is closed before parsing", async () => {
      const content = new TextEncoder().encode("hello");
      const zipData = createTestZip("hello.txt", content);
      const fileHandle = await writeToOpfs("test-opfs-close-before-from.zip", zipData);
      const source = await FileSystemFileHandleSource.open(fileHandle);
      await source.close();
      await expect(ZipReader.from(source)).rejects.toThrow("Source is closed");
    });

    it("iteration fails gracefully when source is closed after from()", async () => {
      const content = new TextEncoder().encode("hello");
      const zipData = createTestZip("hello.txt", content);
      const fileHandle = await writeToOpfs("test-opfs-close-mid-iter.zip", zipData);
      const source = await FileSystemFileHandleSource.open(fileHandle);
      const zip = await ZipReader.from(source);
      await source.close(); // close externally after reader is created
      await expect(
        (async () => {
          for await (const _entry of zip) {
            // CD read should fail
          }
        })()
      ).rejects.toThrow("Source is closed");
    });

    it("entry stream fails gracefully when source is closed before reading", async () => {
      const content = new TextEncoder().encode("hello");
      const zipData = createTestZip("hello.txt", content);
      const fileHandle = await writeToOpfs("test-opfs-close-before-stream.zip", zipData);
      const source = await FileSystemFileHandleSource.open(fileHandle);
      const zip = await ZipReader.from(source);
      const entries: ZipEntry[] = [];
      for await (const entry of zip) {
        entries.push(entry);
      }
      await source.close(); // consumer closes the source directly
      const stream = entries[0].readable();
      await expect(collectStream(stream)).rejects.toThrow("Source is closed");
    });
  });
});
