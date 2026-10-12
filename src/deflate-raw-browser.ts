// WebKit inflates a whole input chunk into one output chunk, so a 64 KiB write
// can emit 64 MiB at once; 16 KiB writes cap that at ~16 MiB
export const MAX_DECOMPRESSOR_WRITE = 16384;

export function createDeflateRawDecompressionStream(): TransformStream<
  Uint8Array<ArrayBuffer>,
  Uint8Array<ArrayBuffer>
> {
  return new DecompressionStream("deflate-raw") as TransformStream<
    Uint8Array<ArrayBuffer>,
    Uint8Array<ArrayBuffer>
  >;
}
