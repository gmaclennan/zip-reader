import type { RandomAccessSource } from "../types.js";

export class BlobSource implements RandomAccessSource {
  readonly size: number;
  readonly #blob: Blob;

  constructor(blob: Blob) {
    this.#blob = blob;
    this.size = blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset + length > this.size) {
      throw new RangeError(
        `Read out of bounds: offset=${offset} length=${length} size=${this.size}`
      );
    }
    const slice = this.#blob.slice(offset, offset + length);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
