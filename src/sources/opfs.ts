import type { RandomAccessSource } from "../types.js";

/**
 * A RandomAccessSource backed by an OPFS (Origin Private File System)
 * FileSystemFileHandle. Suitable for browser environments where a ZIP file
 * has been stored in the Origin Private File System.
 *
 * Use the static `FileSystemFileHandleSource.open()` factory to construct an
 * instance, as reading the file size requires an async call to `getFile()`.
 *
 * @example
 * ```ts
 * const root = await navigator.storage.getDirectory();
 * const handle = await root.getFileHandle("archive.zip");
 * const source = await FileSystemFileHandleSource.open(handle);
 * const zip = await ZipReader.from(source);
 * ```
 */
export class FileSystemFileHandleSource implements RandomAccessSource {
  readonly size: number;
  readonly #file: File;

  private constructor(file: File) {
    this.#file = file;
    this.size = file.size;
  }

  static async open(
    handle: FileSystemFileHandle
  ): Promise<FileSystemFileHandleSource> {
    const file = await handle.getFile();
    return new FileSystemFileHandleSource(file);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset + length > this.size) {
      throw new RangeError(
        `Read out of bounds: offset=${offset} length=${length} size=${this.size}`
      );
    }
    const slice = this.#file.slice(offset, offset + length);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
