import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ZipReader, ZipEntry } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { macArchive } from "../src/mac-archive.js";

const MAC_FIXTURES_DIR = resolve(import.meta.dirname, "./fixtures/mac");

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
      if (entry === ".git_please_make_this_directory") continue;
      const fullPath = join(dir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files[`${relativePath}/`] = null;
        walk(fullPath, relativePath);
      } else {
        files[relativePath] = new Uint8Array(readFileSync(fullPath));
      }
    }
  }
  walk(dirPath, "");
  return files;
}

function fromBuffer(data: Uint8Array) {
  return ZipReader.from(new BufferSource(data), {
    macArchiveFactory: macArchive,
  });
}

describe("Mac OS Archive Utility ZIPs", () => {
  it("handles empty files", async () => {
    const zipPath = join(MAC_FIXTURES_DIR, "empty-files.zip");
    const expectedFiles = getExpectedFiles(
      join(MAC_FIXTURES_DIR, "empty-files"),
    );

    const zipData = readFileSync(zipPath);
    const zip = await fromBuffer(new Uint8Array(zipData));

    let entryCount = 0;
    for await (const entry of zip) {
      entryCount++;
      const filename = entry.name;
      if (entry.isDirectory) {
        expect(expectedFiles[filename]).toBeNull();
      } else {
        const stream = entry.readable();
        const content = await collectStream(stream);
        expect(content).toEqual(expectedFiles[filename]);
      }
    }
    expect(entryCount).toBe(Object.keys(expectedFiles).length);
  });

  it("handles folders", async () => {
    const zipPath = join(MAC_FIXTURES_DIR, "folders.zip");
    const expectedFiles = getExpectedFiles(join(MAC_FIXTURES_DIR, "folders"));

    const zipData = readFileSync(zipPath);
    const zip = await fromBuffer(new Uint8Array(zipData));

    let entryCount = 0;
    for await (const entry of zip) {
      entryCount++;
      const filename = entry.name;
      if (entry.isDirectory) {
        expect(expectedFiles[filename]).toBeNull();
      } else {
        const stream = entry.readable();
        const content = await collectStream(stream);
        expect(content).toEqual(expectedFiles[filename]);
      }
    }
    expect(entryCount).toBe(Object.keys(expectedFiles).length);
  });

  describe("handles large number of files", () => {
    const sizes = [65534, 65535, 65536, 65537, 131072, 200000];

    for (const entryCount of sizes) {
      it(`${entryCount} files`, { timeout: 120000 }, async () => {
        const zipPath = join(MAC_FIXTURES_DIR, `${entryCount}-files.zip`);
        if (!existsSync(zipPath)) return;

        const zipData = readFileSync(zipPath);
        const zip = await fromBuffer(new Uint8Array(zipData));

        const received = new Set<number>();
        let fileCount = 0;

        for await (const entry of zip) {
          fileCount++;
          const match = entry.name.match(/^(\d+)\.txt$/);
          expect(match).toBeTruthy();
          const num = Number(match![1]);
          expect(received.has(num)).toBe(false);
          received.add(num);

          const stream = entry.readable();
          const content = await collectStream(stream);
          const text = new TextDecoder().decode(content);
          expect(text).toBe(`${num}\n`);
        }
        expect(fileCount).toBe(entryCount);
      });
    }
  });
});
