import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import type { BrowserCommandContext } from "vitest/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures");

/**
 * All paths accepted by these commands are relative to the fixtures directory.
 * The server (Node.js) side resolves them to absolute paths.
 */

/** List .zip files in a fixture subdirectory (relative to fixtures/) */
export function listZipFiles(
  _ctx: BrowserCommandContext,
  relDirPath: string,
): string[] {
  const dir = join(FIXTURES_DIR, relDirPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".zip"));
}

/** Read a fixture file (path relative to fixtures/) and return it as base64 */
export function readFileAsBase64(
  _ctx: BrowserCommandContext,
  relFilePath: string,
): string {
  return readFileSync(join(FIXTURES_DIR, relFilePath)).toString("base64");
}

/**
 * Recursively read a fixture expected-files directory (relative to fixtures/).
 * Returns a map of relative paths to base64-encoded content (null for directories).
 */
export function getExpectedFilesData(
  _ctx: BrowserCommandContext,
  relDirPath: string,
): Record<string, string | null> {
  const dirPath = join(FIXTURES_DIR, relDirPath);
  const files: Record<string, string | null> = {};
  if (!existsSync(dirPath)) return files;

  function walk(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir)) {
      if (
        entry === ".git_please_make_this_directory" ||
        entry.startsWith(".dont_expect_")
      )
        continue;
      const fullPath = join(dir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(fullPath).isDirectory()) {
        files[`${relativePath}/`] = null;
        walk(fullPath, relativePath);
      } else {
        files[relativePath] = readFileSync(fullPath).toString("base64");
      }
    }
  }

  walk(dirPath, "");
  return files;
}

/** Load fixture options JSON (zip path relative to fixtures/) */
export function loadFixtureOptionsCmd(
  _ctx: BrowserCommandContext,
  relZipPath: string,
): Record<string, unknown> {
  const jsonPath = join(
    FIXTURES_DIR,
    relZipPath.replace(/\.zip$/, ".json"),
  );
  if (existsSync(jsonPath)) {
    return JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<
      string,
      unknown
    >;
  }
  return {};
}

// Augment the vitest/browser BrowserCommands interface for type safety
declare module "vitest/browser" {
  interface BrowserCommands {
    listZipFiles(relDirPath: string): Promise<string[]>;
    readFileAsBase64(relFilePath: string): Promise<string>;
    getExpectedFilesData(
      relDirPath: string,
    ): Promise<Record<string, string | null>>;
    loadFixtureOptionsCmd(relZipPath: string): Promise<Record<string, unknown>>;
  }
}
