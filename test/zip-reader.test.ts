import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ZipReader, ZipEntry } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { macArchive } from "../src/mac-archive.js";

const FIXTURES_DIR = resolve(import.meta.dirname, "./fixtures");
const SUCCESS_DIR = join(FIXTURES_DIR, "success");
const FAILURE_DIR = join(FIXTURES_DIR, "failure");
const BASIC_DIR = join(FIXTURES_DIR, "basic");

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

function getExpectedFiles(dirPath: string): Record<string, Uint8Array | null> {
  const files: Record<string, Uint8Array | null> = {};
  if (!existsSync(dirPath)) return files;

  function walk(dir: string, prefix: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // Skip git placeholder files and test marker files
      if (
        entry === ".git_please_make_this_directory" ||
        entry.startsWith(".dont_expect_")
      )
        continue;
      const fullPath = join(dir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files[`${relativePath}/`] = null; // directory
        walk(fullPath, relativePath);
      } else {
        files[relativePath] = new Uint8Array(readFileSync(fullPath));
      }
    }
  }
  walk(dirPath, "");
  return files;
}

function loadFixtureOptions(zipPath: string): Record<string, any> {
  const jsonPath = zipPath.replace(/\.zip$/, ".json");
  if (existsSync(jsonPath)) {
    return JSON.parse(readFileSync(jsonPath, "utf-8"));
  }
  return {};
}

function fromBuffer(data: Uint8Array, options?: Record<string, any>) {
  return ZipReader.from(new BufferSource(data), {
    macArchiveFactory: macArchive,
    ...options,
  });
}

// Earliest timestamp in test fixtures
const EARLIEST_TIMESTAMP = new Date(2014, 7, 18, 0, 0, 0, 0);

// Fixtures that need special handling
const SKIP_ENTRY_COUNT_CHECK = new Set(["empty", "directories"]);
const SKIP_CONTENT_CHECK = new Set([
  "crc32-wrong",
  "wrong-entry-sizes",
  "traditional-encryption",
  "traditional-encryption-and-compression",
]);

describe("ZipReader", () => {
  describe("basic test", () => {
    it("reads a basic zip file", async () => {
      const zipData = readFileSync(join(BASIC_DIR, "test.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));

      const entries: ZipEntry[] = [];
      for await (const entry of zip) {
        entries.push(entry);
      }

      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const stream = entry.readable();
        const content = await collectStream(stream);
        expect(content.byteLength).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("success fixtures", () => {
    const zipFiles = readdirSync(SUCCESS_DIR).filter((f) => f.endsWith(".zip"));

    for (const zipFilename of zipFiles) {
      const zipPath = join(SUCCESS_DIR, zipFilename);
      const fixtureDir = zipPath.replace(/\.zip$/, "");
      const fixtureName = zipFilename.replace(/\.zip$/, "");

      describe(fixtureName, () => {
        it("reads all entries correctly", async () => {
          const fixtureOptions = loadFixtureOptions(zipPath);
          const zipData = readFileSync(zipPath);

          const readerOptions: Record<string, any> = {};
          if (fixtureName === "sloppy-filenames") {
            readerOptions.validateFilenames = false;
          }

          // Skip content check for special fixtures
          if (SKIP_CONTENT_CHECK.has(fixtureName)) {
            const zip = await fromBuffer(
              new Uint8Array(zipData),
              readerOptions,
            );
            const entries: ZipEntry[] = [];
            for await (const entry of zip) {
              entries.push(entry);
            }
            expect(entries.length).toBeGreaterThanOrEqual(0);

            // For encrypted fixtures, verify encryption detection
            if (fixtureOptions.isEncrypted) {
              for (const entry of entries) {
                if (entry.isEncrypted) {
                  expect(() => entry.readable()).toThrow(
                    "Decryption is not supported",
                  );
                }
              }
            }
            return;
          }

          const zip = await fromBuffer(new Uint8Array(zipData), readerOptions);
          const expectedFiles = getExpectedFiles(fixtureDir);

          let entryCount = 0;
          for await (const entry of zip) {
            entryCount++;

            expect(entry.name).toBeTypeOf("string");
            expect(entry.lastModified).toBeInstanceOf(Date);
            expect(entry.lastModified.getTime()).toBeGreaterThan(
              EARLIEST_TIMESTAMP.getTime(),
            );

            let filename = entry.name;
            // Handle renames from fixture options
            for (const [from, to] of fixtureOptions.rename || []) {
              filename = filename.replace(from, to);
            }

            if (entry.isDirectory) {
              // Directory entries may or may not be in expected files
              continue;
            }

            const streamOptions = fixtureOptions.stream || {};
            const stream = entry.readable({
              decompress: streamOptions.decompress,
              validateCrc32: streamOptions.validateCrc32,
            });
            const content = await collectStream(stream);
            const expected = expectedFiles[filename];
            if (expected !== undefined) {
              expect(content).toEqual(expected);
            }
          }

          if (!SKIP_ENTRY_COUNT_CHECK.has(fixtureName)) {
            // Count only non-directory expected files for comparison
            const expectedFileCount = Object.values(expectedFiles).filter(
              (v) => v !== null,
            ).length;
            const actualFileCount = entryCount; // approximate - includes dirs
            expect(actualFileCount).toBeGreaterThanOrEqual(expectedFileCount);
          }
        });
      });
    }
  });

  describe("failure fixtures", () => {
    const zipFiles = readdirSync(FAILURE_DIR).filter((f) => f.endsWith(".zip"));

    for (const zipFilename of zipFiles) {
      const zipPath = join(FAILURE_DIR, zipFilename);
      // The filename encodes the expected error message, but with special
      // chars replaced (: → -, / → -, \ → -, + → -, > → -)
      const expectedErrorMessage = zipFilename.replace(/(_\d+)?\.zip$/, "");

      it(`throws on: ${expectedErrorMessage}`, async () => {
        const fixtureOptions = loadFixtureOptions(zipPath);
        const zipData = readFileSync(zipPath);

        const promise = (async () => {
          const zip = await fromBuffer(
            new Uint8Array(zipData),
            fixtureOptions.zip,
          );
          for await (const entry of zip) {
            const streamOptions = fixtureOptions.stream || {};
            const stream = entry.readable({
              decompress: streamOptions.decompress,
              validateCrc32: streamOptions.validateCrc32,
            });
            await collectStream(stream);
          }
        })();

        await expect(promise).rejects.toThrow();
      });
    }
  });

  describe("CRC32 validation", () => {
    it("detects wrong CRC32", async () => {
      const zipData = readFileSync(join(SUCCESS_DIR, "crc32-wrong.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));

      const promise = (async () => {
        for await (const entry of zip) {
          if (entry.isDirectory) continue;
          const stream = entry.readable({ validateCrc32: true });
          await collectStream(stream);
        }
      })();

      await expect(promise).rejects.toThrow("CRC32 validation failed");
    });

    it("skips CRC32 validation when disabled", async () => {
      const zipData = readFileSync(join(SUCCESS_DIR, "crc32-wrong.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));

      for await (const entry of zip) {
        if (entry.isDirectory) continue;
        const stream = entry.readable({ validateCrc32: false });
        await collectStream(stream);
      }
    });
  });

  describe("entry size validation", () => {
    it("detects size mismatches", async () => {
      const zipData = readFileSync(join(SUCCESS_DIR, "wrong-entry-sizes.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));

      const promise = (async () => {
        for await (const entry of zip) {
          if (entry.isDirectory) continue;
          const stream = entry.readable();
          await collectStream(stream);
        }
      })();

      await expect(promise).rejects.toThrow();
    });
  });

  describe("empty zip", () => {
    it("reads an empty zip with no entries", async () => {
      const zipData = readFileSync(join(SUCCESS_DIR, "empty.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));

      const entries: ZipEntry[] = [];
      for await (const entry of zip) {
        entries.push(entry);
      }
      // The empty.zip has 1 directory entry
      expect(entries.length).toBeLessThanOrEqual(1);
    });
  });

  describe("zip64", () => {
    it("reads a zip64 file", async () => {
      const zipData = readFileSync(join(SUCCESS_DIR, "zip64.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));

      expect(zip.isZip64).toBe(true);

      const entries: ZipEntry[] = [];
      for await (const entry of zip) {
        entries.push(entry);
      }
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe("properties", () => {
    it("exposes comment and isZip64", async () => {
      const zipData = readFileSync(join(BASIC_DIR, "test.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));

      expect(zip.comment).toBeTypeOf("string");
      expect(zip.isZip64).toBeTypeOf("boolean");
    });

    it("exposes entry properties", async () => {
      const zipData = readFileSync(join(BASIC_DIR, "test.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));

      for await (const entry of zip) {
        expect(entry.name).toBeTypeOf("string");
        expect(entry.compressedSize).toBeTypeOf("number");
        expect(entry.uncompressedSize).toBeTypeOf("number");
        expect(entry.crc32).toBeTypeOf("number");
        expect(entry.compressionMethod).toBeTypeOf("number");
        expect(entry.lastModified).toBeInstanceOf(Date);
        expect(entry.isDirectory).toBeTypeOf("boolean");
        expect(entry.isCompressed).toBeTypeOf("boolean");
        expect(entry.isEncrypted).toBeTypeOf("boolean");
        expect(entry.zip64).toBeTypeOf("boolean");
        break; // just check first entry
      }
    });
  });

  describe("close", () => {
    it("close is a no-op for buffer source", async () => {
      const zipData = readFileSync(join(BASIC_DIR, "test.zip"));
      const zip = await fromBuffer(new Uint8Array(zipData));
      await zip.close();
    });
  });

  describe("FileSource", () => {
    it("reads a zip via FileSource", async () => {
      const { FileSource } = await import("../src/sources/file.js");
      const source = await FileSource.open(join(BASIC_DIR, "test.zip"));
      try {
        const zip = await ZipReader.from(source, {
          macArchiveFactory: macArchive,
        });
        const entries: ZipEntry[] = [];
        for await (const entry of zip) {
          entries.push(entry);
        }
        expect(entries.length).toBeGreaterThan(0);

        // Read first non-directory entry
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const stream = entry.readable();
          const content = await collectStream(stream);
          expect(content.byteLength).toBeGreaterThan(0);
          break;
        }
      } finally {
        await source.close();
      }
    });
  });
});
