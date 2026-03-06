/**
 * ZIP Reading Benchmarks (in-memory)
 *
 * Compares zip-reader performance against popular Node.js ZIP libraries:
 * - yauzl-promise: The most popular ZIP reader for Node.js
 * - fflate: Fast compression library with sync unzip
 * - @zip.js/zip.js: Modern ZIP library with Web Streams support
 *
 * All benchmarks read from in-memory buffers and consume all entry data.
 * Fixture ZIPs are lazily created using setup hooks to exclude setup time.
 */

import { describe, bench } from "vitest";
import { ZipReader } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { createFixtureZip } from "./create-fixture.js";
import * as yauzlPromise from "yauzl-promise";
import { unzipSync } from "fflate";
import { ZipReader as ZipJsReader, Uint8ArrayWriter } from "@zip.js/zip.js";

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

async function benchmarkZipReader(zipData: Uint8Array): Promise<void> {
  const zip = await ZipReader.from(new BufferSource(zipData));
  for await (const entry of zip) {
    if (entry.isDirectory) continue;
    await consumeStream(entry.readable());
  }
}

async function benchmarkYauzlPromise(zipData: Uint8Array): Promise<void> {
  const zip = await yauzlPromise.fromBuffer(Buffer.from(zipData));
  try {
    for await (const entry of zip) {
      if (entry.filename.endsWith("/")) continue;
      const stream = await entry.openReadStream();
      // yauzl returns Node Readable, consume manually
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

function benchmarkFflate(zipData: Uint8Array): void {
  unzipSync(zipData);
}

async function benchmarkZipJs(zipData: Uint8Array): Promise<void> {
  const blob = new Blob([zipData as unknown as ArrayBuffer]);
  const reader = new ZipJsReader(new Response(blob).body!);
  const entries = await reader.getEntries();
  for (const entry of entries) {
    if (entry.directory) continue;
    await entry.getData!(new Uint8ArrayWriter());
  }
  await reader.close();
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
  let zipData: Uint8Array;

  async function setup() {
    if (zipData) return;
    zipData = await createFixtureZip(fileCount, fileSize);
  }

  bench("zip-reader", async () => benchmarkZipReader(zipData), {
    setup,
    ...benchOptions,
  });

  bench("yauzl-promise", async () => benchmarkYauzlPromise(zipData), {
    setup,
    ...benchOptions,
  });

  bench("fflate", () => benchmarkFflate(zipData), {
    setup,
    ...benchOptions,
  });

  bench("@zip.js/zip.js", async () => benchmarkZipJs(zipData), {
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
