import { describe, it, expect } from "vitest";
import { createNodeInflateRawStream } from "../src/deflate-raw-node.js";
import { deflateRawZeros } from "./fixture-helpers.js";

type ByteTransform = TransformStream<
  Uint8Array<ArrayBuffer>,
  Uint8Array<ArrayBuffer>
>;

const inflaters: Array<[string, () => ByteTransform]> = [
  [
    "native DecompressionStream",
    () => new DecompressionStream("deflate-raw") as unknown as ByteTransform,
  ],
  ["createInflateRaw fallback", createNodeInflateRawStream],
];

describe.each(inflaters)("Node %s", (_, createInflate) => {
  it("does not inflate ahead of the reader", async () => {
    const compressed = await deflateRawZeros(512 << 20);
    let offset = 0;
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        if (offset >= compressed.length) return controller.close();
        controller.enqueue(compressed.slice(offset, offset + 16384));
        offset += 16384;
      },
    });
    const before = process.memoryUsage().arrayBuffers;
    const reader = input.pipeThrough(createInflate()).getReader();
    let delivered = 0;
    while (delivered < 1 << 20) {
      const { done, value } = await reader.read();
      if (done) break;
      delivered += value.byteLength;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const growth = process.memoryUsage().arrayBuffers - before;
    await reader.cancel();
    // Eager inflation would hold up to 512 MiB
    expect(growth).toBeLessThan(64 << 20);
  }, 30_000);

  it("inflates valid data", async () => {
    const compressed = await deflateRawZeros(100_000);
    const output = await new Response(
      new Blob([compressed]).stream().pipeThrough(createInflate()),
    ).arrayBuffer();
    expect(output.byteLength).toBe(100_000);
  });

  it("rejects corrupt data", async () => {
    const input = new Blob([new Uint8Array([0xff, 0xff])]).stream();
    await expect(
      new Response(input.pipeThrough(createInflate())).arrayBuffer(),
    ).rejects.toThrow();
  });

  // ZipEntry relies on this to tell upstream errors from decompression errors
  it("passes an upstream error through as the same object", async () => {
    const upstream = new Error("source failed");
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        controller.error(upstream);
      },
    });
    const reader = input.pipeThrough(createInflate()).getReader();
    await expect(reader.read()).rejects.toBe(upstream);
  });
});
