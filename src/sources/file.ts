/// <reference types="node" />
import type { RandomAccessSource } from "../types.js";
import { open, stat, type FileHandle } from "node:fs/promises";

export class FileSource implements RandomAccessSource {
  readonly size: number;
  readonly #handle: FileHandle;
  #closed = false;

  private constructor(handle: FileHandle, size: number) {
    this.#handle = handle;
    this.size = size;
  }

  static async open(path: string): Promise<FileSource> {
    const handle = await open(path, "r");
    const stats = await stat(path);
    return new FileSource(handle, stats.size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.#closed) {
      throw new Error("Source is closed");
    }
    if (offset < 0 || offset + length > this.size) {
      throw new RangeError(
        `Read out of bounds: offset=${offset} length=${length} size=${this.size}`
      );
    }
    const buffer = new Uint8Array(length);
    const { bytesRead } = await this.#handle.read(buffer, 0, length, offset);
    if (bytesRead < length) {
      return buffer.subarray(0, bytesRead);
    }
    return buffer;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}
