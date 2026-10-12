import { createInflateRaw } from "node:zlib";
import { Duplex } from "node:stream";

// Node's inflate emits output in bounded chunks whatever the input size
export const MAX_DECOMPRESSOR_WRITE = Infinity;

let nativeSupported: boolean;
try {
  new DecompressionStream("deflate-raw");
  nativeSupported = true;
} catch {
  nativeSupported = false;
}

export function createDeflateRawDecompressionStream(): TransformStream<
  Uint8Array<ArrayBuffer>,
  Uint8Array<ArrayBuffer>
> {
  if (nativeSupported) {
    return new DecompressionStream("deflate-raw") as TransformStream<
      Uint8Array<ArrayBuffer>,
      Uint8Array<ArrayBuffer>
    >;
  }
  return createNodeInflateRawStream();
}

/** Fallback for Node versions without native `deflate-raw` support */
export function createNodeInflateRawStream(): TransformStream<
  Uint8Array<ArrayBuffer>,
  Uint8Array<ArrayBuffer>
> {
  return Duplex.toWeb(createInflateRaw()) as unknown as TransformStream<
    Uint8Array<ArrayBuffer>,
    Uint8Array<ArrayBuffer>
  >;
}
