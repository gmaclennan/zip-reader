import type { RandomAccessSource } from "../types.js";

export class BufferSource implements RandomAccessSource {
  readonly size: number;
  readonly #data: Uint8Array;

  constructor(data: Uint8Array | ArrayBuffer) {
    this.#data =
      data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.size = this.#data.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset + length > this.size) {
      throw new RangeError(
        `Read out of bounds: offset=${offset} length=${length} size=${this.size}`
      );
    }
    return this.#data.subarray(offset, offset + length);
  }
}
