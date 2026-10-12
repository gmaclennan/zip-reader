/**
 * ZIP Reading Benchmarks (in-memory)
 *
 * Compares zip-reader performance against popular Node.js ZIP libraries:
 * - yauzl-promise: The most popular ZIP reader for Node.js
 * - fflate: Fast compression library with sync unzip
 * - @zip.js/zip.js: Modern ZIP library with Web Streams support
 *
 * All benchmarks read from in-memory buffers and consume all entry data.
 * Fixture ZIPs are created before each comparison runs, so setup time is excluded.
 */

import { test, type BenchRunOptions } from "vitest";
import { ZipReader } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { createFixtureZip } from "./create-fixture.js";
import * as yauzlPromise from "yauzl-promise";
import { unzipSync } from "fflate";
import { ZipReader as ZipJsReader, Uint8ArrayWriter } from "@zip.js/zip.js";

async function consumeStream(
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// ---- Benchmark functions ----

async function benchmarkZipReader(
  zipData: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const zip = await ZipReader.from(new BufferSource(zipData));
  for await (const entry of zip) {
    if (entry.isDirectory) continue;
    await consumeStream(entry.readable());
  }
}

async function benchmarkYauzlPromise(
  zipData: Uint8Array<ArrayBuffer>,
): Promise<void> {
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

function benchmarkFflate(zipData: Uint8Array<ArrayBuffer>): void {
  unzipSync(zipData);
}

async function benchmarkZipJs(zipData: Uint8Array<ArrayBuffer>): Promise<void> {
  const blob = new Blob([zipData]);
  const reader = new ZipJsReader(new Response(blob).body!);
  const entries = await reader.getEntries();
  for (const entry of entries) {
    if (entry.directory) continue;
    await entry.getData!(new Uint8ArrayWriter());
  }
  await reader.close();
}

// ---- Parametric benchmark suite ----

function benchmarks(
  name: string,
  {
    fileCount,
    fileSize,
    ...runOptions
  }: { fileCount: number; fileSize: number } & BenchRunOptions,
) {
  test(name, async ({ bench }) => {
    const zipData = await createFixtureZip(fileCount, fileSize);

    await bench.compare(
      bench("zip-reader", () => benchmarkZipReader(zipData)),
      bench("yauzl-promise", () => benchmarkYauzlPromise(zipData)),
      bench("fflate", () => benchmarkFflate(zipData)),
      bench("@zip.js/zip.js", () => benchmarkZipJs(zipData)),
      runOptions,
    );
  });
}

benchmarks("Small files (10 × 10KB)", {
  fileCount: 10,
  fileSize: 10 * 1024,
  iterations: 10,
  time: 1000,
});

benchmarks("Medium files (100 × 100KB)", {
  fileCount: 100,
  fileSize: 100 * 1024,
  iterations: 5,
  time: 1000,
});

benchmarks("Large files (5 × 10MB)", {
  fileCount: 5,
  fileSize: 10 * 1024 * 1024,
  time: 1000,
});

benchmarks("Many files (1000 × 1KB)", {
  fileCount: 1000,
  fileSize: 1024,
  iterations: 5,
  time: 1000,
});
