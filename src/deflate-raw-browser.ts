export function createDeflateRawDecompressionStream(): TransformStream<
  Uint8Array<ArrayBuffer>,
  Uint8Array<ArrayBuffer>
> {
  return new DecompressionStream("deflate-raw") as TransformStream<
    Uint8Array<ArrayBuffer>,
    Uint8Array<ArrayBuffer>
  >;
}
