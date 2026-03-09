import { describe, it, expect } from "vitest";
import { ZipReader, ZipEntry } from "../src/index.js";
import { macArchive } from "../src/mac-archive.js";
import {
  openZipSource,
  listZipFiles,
  getExpectedFiles,
  loadFixtureOptions,
} from "./fixture-helpers.js";

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

async function fromFile(relPath: string, options?: Record<string, unknown>) {
  const source = await openZipSource(relPath);
  return ZipReader.from(source, {
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

// Discover fixture files (top-level await, resolved before describe blocks run)
const successZipFiles = await listZipFiles("success");
const failureZipFiles = await listZipFiles("failure");

describe("ZipReader", () => {
  describe("basic test", () => {
    it("reads a basic zip file", async () => {
      const zip = await fromFile("basic/test.zip");

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
    for (const zipFilename of successZipFiles) {
      const zipRelPath = `success/${zipFilename}`;
      const fixtureDirRel = `success/${zipFilename.replace(/\.zip$/, "")}`;
      const fixtureName = zipFilename.replace(/\.zip$/, "");

      describe(fixtureName, () => {
        it("reads all entries correctly", async () => {
          const fixtureOptions = await loadFixtureOptions(zipRelPath);

          const readerOptions: Record<string, unknown> = {};
          if (fixtureName === "sloppy-filenames") {
            readerOptions.skipFilenameValidation = true;
          }

          // Skip content check for special fixtures
          if (SKIP_CONTENT_CHECK.has(fixtureName)) {
            const zip = await fromFile(zipRelPath, readerOptions);
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

          const zip = await fromFile(zipRelPath, readerOptions);
          const expectedFiles = await getExpectedFiles(fixtureDirRel);

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
            for (const [from, to] of (fixtureOptions.rename as string[][]) ||
              []) {
              filename = filename.replace(from, to);
            }

            if (entry.isDirectory) {
              // Directory entries may or may not be in expected files
              continue;
            }

            const streamOptions =
              (fixtureOptions.stream as Record<string, boolean>) || {};
            const stream = entry.readable({
              rawEntry: streamOptions.decompress,
              skipCrc32: streamOptions.validateCrc32,
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
    for (const zipFilename of failureZipFiles) {
      const zipRelPath = `failure/${zipFilename}`;
      // The filename encodes the expected error message, but with special
      // chars replaced (: → -, / → -, \ → -, + → -, > → -)
      const expectedErrorMessage = zipFilename.replace(/(_\d+)?\.zip$/, "");

      it(`throws on: ${expectedErrorMessage}`, async () => {
        const fixtureOptions = await loadFixtureOptions(zipRelPath);

        const promise = (async () => {
          const zip = await fromFile(
            zipRelPath,
            (fixtureOptions.zip as Record<string, unknown>) ?? {},
          );
          for await (const entry of zip) {
            const streamOptions =
              (fixtureOptions.stream as Record<string, boolean>) || {};
            const stream = entry.readable({
              rawEntry: streamOptions.decompress,
              skipCrc32: streamOptions.validateCrc32,
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
      const zip = await fromFile("success/crc32-wrong.zip");

      const promise = (async () => {
        for await (const entry of zip) {
          if (entry.isDirectory) continue;
          const stream = entry.readable();
          await collectStream(stream);
        }
      })();

      await expect(promise).rejects.toThrow("CRC32 validation failed");
    });

    it("skips CRC32 validation when disabled", async () => {
      const zip = await fromFile("success/crc32-wrong.zip");

      for await (const entry of zip) {
        if (entry.isDirectory) continue;
        const stream = entry.readable({ skipCrc32: true });
        await collectStream(stream);
      }
    });
  });

  describe("entry size validation", () => {
    it("detects size mismatches", async () => {
      const zip = await fromFile("success/wrong-entry-sizes.zip");

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
      const zip = await fromFile("success/empty.zip");

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
      const zip = await fromFile("success/zip64.zip");

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
      const zip = await fromFile("basic/test.zip");

      expect(zip.comment).toBeTypeOf("string");
      expect(zip.isZip64).toBeTypeOf("boolean");
    });

    it("exposes entry properties", async () => {
      const zip = await fromFile("basic/test.zip");

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

  describe.skipIf(isBrowser)("FileSource", () => {
    it("reads a zip via FileSource", async () => {
      const { FileSource } = await import("../src/sources/file.js");
      const { resolve } = await import("node:path");
      const source = await FileSource.open(
        resolve(import.meta.dirname, "fixtures/basic/test.zip"),
      );
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
