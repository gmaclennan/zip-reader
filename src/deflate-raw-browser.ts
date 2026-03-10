export function createDeflateRawDecompressionStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  return new DecompressionStream("deflate-raw") as TransformStream<
    Uint8Array,
    Uint8Array
  >;
}
