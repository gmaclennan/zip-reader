/**
 * ZIP Reading Benchmarks (in-memory)
 *
 * Every library reads the same ZIP from an in-memory buffer and decompresses
 * all entry data. Fixture ZIPs are created before each comparison runs, so
 * setup time is excluded.
 */

import { test, type BenchRunOptions } from "vitest";
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
  test(name, async ({ bench }) => {
    const data = await createFixtureZip(fileCount, fileSize);

    await bench.compare(
      bench("zip-reader", () => readers.zipReaderBuffer(data)),
      bench("zip-reader (js crc32)", () =>
        readers.zipReaderBufferJsCrc32(data),
      ),
      bench("yauzl", () => readers.yauzlBuffer(data)),
      bench("yauzl-promise", () => readers.yauzlPromiseBuffer(data)),
      bench("fflate", () => readers.fflateBuffer(data)),
      bench("@zip.js/zip.js", () => readers.zipJsBuffer(data)),
      bench("adm-zip", () => readers.admZipBuffer(data)),
      bench("jszip", () => readers.jszipBuffer(data)),
      bench("unzipper", () => readers.unzipperBuffer(data)),
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
  iterations: 10,
  time: 1000,
});

benchmarks("Many files (1000 × 1KB)", {
  fileCount: 1000,
  fileSize: 1024,
  iterations: 5,
  time: 1000,
});
