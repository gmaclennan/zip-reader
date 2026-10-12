/**
 * ZIP Reading Benchmarks (from files)
 *
 * Every library reads the same ZIP file from disk and decompresses all entry
 * data. Libraries that can read with random access do so; fflate and jszip
 * only accept a buffer, so they read the whole file into memory first.
 * Fixture ZIPs are created before each comparison runs, so setup time is
 * excluded.
 */

import { test, type BenchRunOptions } from "vitest";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createFixtureZip } from "./create-fixture.js";
import * as readers from "./readers.js";

function benchmarks(
  name: string,
  {
    fileCount,
    fileSize,
    ...runOptions
  }: { fileCount: number; fileSize: number } & BenchRunOptions,
) {
  test(name, async ({ bench, onTestFinished }) => {
    const tempDir = await mkdtemp(join(tmpdir(), "zip-read-bench-"));
    onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
    const path = join(tempDir, `fixture-${fileCount}x${fileSize}.zip`);
    await writeFile(path, await createFixtureZip(fileCount, fileSize));

    await bench.compare(
      bench("zip-reader", () => readers.zipReaderFile(path)),
      bench("yauzl", () => readers.yauzlFile(path)),
      bench("yauzl-promise", () => readers.yauzlPromiseFile(path)),
      bench("fflate", () => readers.fflateFile(path)),
      bench("adm-zip", () => readers.admZipFile(path)),
      bench("jszip", () => readers.jszipFile(path)),
      bench("unzipper", () => readers.unzipperFile(path)),
      bench("node-stream-zip", () => readers.nodeStreamZipFile(path)),
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
  iterations: 5,
  warmupIterations: 2,
  time: 1000,
});

benchmarks("Many files (1000 × 1KB)", {
  fileCount: 1000,
  fileSize: 1024,
  iterations: 5,
  time: 1000,
});
