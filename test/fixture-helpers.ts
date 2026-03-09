import { onTestFinished } from "vitest";
import type { RandomAccessSource } from "../src/types.js";

const isBrowser = typeof window !== "undefined";

// Node only: absolute path to the fixtures directory.
// `import.meta.dirname` works in Node (ESM) but is undefined in browser vitest.
const FIXTURES_DIR_ABS = isBrowser
  ? ""
  : `${import.meta.dirname}/fixtures`;

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Open a fixture ZIP file as a RandomAccessSource.
 * @param relPath - path relative to the fixtures/ directory (e.g. "basic/test.zip")
 * - Node: uses FileSource (file handle, auto-closed after each test)
 * - Browser: reads via vitest command, wraps in BlobSource
 */
export async function openZipSource(
  relPath: string,
): Promise<RandomAccessSource> {
  if (isBrowser) {
    const { commands } = await import("vitest/browser");
    const base64 = await commands.readFileAsBase64(relPath);
    const bytes = base64ToUint8Array(base64);
    const { BlobSource } = await import("../src/sources/blob.js");
    return new BlobSource(new Blob([bytes.buffer as ArrayBuffer]));
  } else {
    const { FileSource } = await import("../src/sources/file.js");
    const source = await FileSource.open(`${FIXTURES_DIR_ABS}/${relPath}`);
    onTestFinished(async () => {
      try {
        await source.close();
      } catch {
        // ignore
      }
    });
    return source;
  }
}

/**
 * List .zip files in a fixture subdirectory.
 * @param relDirPath - path relative to fixtures/ (e.g. "success")
 */
export async function listZipFiles(relDirPath: string): Promise<string[]> {
  if (isBrowser) {
    const { commands } = await import("vitest/browser");
    return commands.listZipFiles(relDirPath);
  } else {
    const { readdirSync } = await import("node:fs");
    return readdirSync(`${FIXTURES_DIR_ABS}/${relDirPath}`).filter(
      (f: string) => f.endsWith(".zip"),
    );
  }
}

/**
 * Get expected files for a fixture directory.
 * @param relDirPath - path relative to fixtures/ (e.g. "success/deflate")
 * Returns a map of relative paths to Uint8Array content (null for directories).
 */
export async function getExpectedFiles(
  relDirPath: string,
): Promise<Record<string, Uint8Array | null>> {
  if (isBrowser) {
    const { commands } = await import("vitest/browser");
    const data = await commands.getExpectedFilesData(relDirPath);
    const result: Record<string, Uint8Array | null> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = value === null ? null : base64ToUint8Array(value);
    }
    return result;
  } else {
    const { readdirSync, statSync, existsSync, readFileSync } = await import(
      "node:fs"
    );
    const dirPath = `${FIXTURES_DIR_ABS}/${relDirPath}`;
    const files: Record<string, Uint8Array | null> = {};
    if (!existsSync(dirPath)) return files;

    function walk(dir: string, prefix: string): void {
      for (const entry of readdirSync(dir)) {
        if (
          entry === ".git_please_make_this_directory" ||
          entry.startsWith(".dont_expect_")
        )
          continue;
        const fullPath = `${dir}/${entry}`;
        const relativePath = prefix ? `${prefix}/${entry}` : entry;
        if (statSync(fullPath).isDirectory()) {
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
}

/**
 * Load fixture options from the JSON file alongside a .zip.
 * @param relZipPath - path relative to fixtures/ (e.g. "success/crc32-wrong.zip")
 */
export async function loadFixtureOptions(
  relZipPath: string,
): Promise<Record<string, unknown>> {
  if (isBrowser) {
    const { commands } = await import("vitest/browser");
    return commands.loadFixtureOptionsCmd(relZipPath);
  } else {
    const { existsSync, readFileSync } = await import("node:fs");
    const jsonPath = `${FIXTURES_DIR_ABS}/${relZipPath.replace(/\.zip$/, ".json")}`;
    if (existsSync(jsonPath)) {
      return JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<
        string,
        unknown
      >;
    }
    return {};
  }
}
