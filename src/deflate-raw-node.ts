import { createInflateRaw } from "node:zlib";
import { Duplex } from "node:stream";

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
  return Duplex.toWeb(createInflateRaw()) as unknown as TransformStream<
    Uint8Array<ArrayBuffer>,
    Uint8Array<ArrayBuffer>
  >;
}
