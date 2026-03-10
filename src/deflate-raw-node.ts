// @ts-expect-error - TS is configured to target DOM, not node
import { createInflateRaw } from "node:zlib";
// @ts-expect-error - TS is configured to target DOM, not node
import { Duplex } from "node:stream";

let nativeSupported: boolean;
try {
  new DecompressionStream("deflate-raw");
  nativeSupported = true;
} catch {
  nativeSupported = false;
}

export function createDeflateRawDecompressionStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  if (nativeSupported) {
    return new DecompressionStream("deflate-raw") as TransformStream<
      Uint8Array,
      Uint8Array
    >;
  }
  return Duplex.toWeb(createInflateRaw()) as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
}
