/**
 * ZIP Reading Benchmarks (from files)
 *
 * Compares zip-reader performance against popular Node.js ZIP libraries
 * when reading from disk. This tests the full I/O path including file handles.
 *
 * - zip-reader (FileSource): Reads via random-access file handles
 * - zip-reader (BufferSource): Reads entire file into memory first
 * - yauzl-promise: Opens file via fd (random access)
 * - fflate: Reads entire file into memory, then unzips synchronously
 *
 * Fixture ZIPs are lazily created using setup hooks to exclude setup time.
 */

import { describe, bench } from "vitest";
import { readFileSync } from "fs";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ZipReader } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { FileSource } from "../src/sources/file.js";
import { createFixtureZip } from "./create-fixture.js";
import * as yauzlPromise from "yauzl-promise";
import { unzipSync } from "fflate";

const tempDir = await mkdtemp(join(tmpdir(), "zip-read-bench-"));
process.on("beforeExit", async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function consumeStream(
  stream: ReadableStream<Uint8Array>
): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// ---- Benchmark functions ----

async function benchmarkZipReaderFile(zipPath: string): Promise<void> {
  const source = await FileSource.open(zipPath);
  try {
    const zip = await ZipReader.from(source);
    for await (const entry of zip) {
      if (entry.isDirectory) continue;
      await consumeStream(entry.readable());
    }
  } finally {
    await source.close();
  }
}

async function benchmarkZipReaderBuffer(zipPath: string): Promise<void> {
  const data = readFileSync(zipPath);
  const zip = await ZipReader.from(new BufferSource(data));
  for await (const entry of zip) {
    if (entry.isDirectory) continue;
    await consumeStream(entry.readable());
  }
}

async function benchmarkYauzlPromise(zipPath: string): Promise<void> {
  const zip = await yauzlPromise.open(zipPath);
  try {
    for await (const entry of zip) {
      if (entry.filename.endsWith("/")) continue;
      const stream = await entry.openReadStream();
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
        stream.resume();
      });
    }
  } finally {
    await zip.close();
  }
}

function benchmarkFflate(zipPath: string): void {
  const data = readFileSync(zipPath);
  unzipSync(new Uint8Array(data));
}

// ---- Parametric benchmark suite ----

function benchmarks({
  fileCount,
  fileSize,
  ...benchOptions
}: {
  fileCount: number;
  fileSize: number;
} & import("vitest").BenchOptions) {
  let zipPath: string;

  async function setup() {
    if (zipPath) return;
    const zipData = await createFixtureZip(fileCount, fileSize);
    zipPath = join(tempDir, `fixture-${fileCount}x${fileSize}.zip`);
    await writeFile(zipPath, zipData);
  }

  bench(
    "zip-reader (FileSource)",
    async () => benchmarkZipReaderFile(zipPath),
    { setup, ...benchOptions }
  );

  bench(
    "zip-reader (BufferSource)",
    async () => benchmarkZipReaderBuffer(zipPath),
    { setup, ...benchOptions }
  );

  bench("yauzl-promise", async () => benchmarkYauzlPromise(zipPath), {
    setup,
    ...benchOptions,
  });

  bench("fflate", () => benchmarkFflate(zipPath), {
    setup,
    ...benchOptions,
  });
}

// ============================================================================
// Small Files Benchmark: 10 files × 10KB each
// ============================================================================

describe("Small files (10 × 10KB)", () => {
  benchmarks({
    fileCount: 10,
    fileSize: 10 * 1024,
    iterations: 10,
    time: 1000,
  });
});

// ============================================================================
// Medium Files Benchmark: 100 files × 100KB each
// ============================================================================

describe("Medium files (100 × 100KB)", () => {
  benchmarks({
    fileCount: 100,
    fileSize: 100 * 1024,
    iterations: 5,
    time: 1000,
  });
});

// ============================================================================
// Large Files Benchmark: 5 files × 10MB each
// ============================================================================

describe("Large files (5 × 10MB)", () => {
  benchmarks({
    fileCount: 5,
    fileSize: 10 * 1024 * 1024,
    time: 1000,
  });
});

// ============================================================================
// Many Files Benchmark: 1000 files × 1KB each
// ============================================================================

describe("Many files (1000 × 1KB)", () => {
  benchmarks({
    fileCount: 1000,
    fileSize: 1024,
    iterations: 5,
    time: 1000,
  });
});
