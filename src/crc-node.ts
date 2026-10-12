import { crc32 as zlibCrc32 } from "node:zlib";

export function crc32(data: Uint8Array, previous?: number): number {
  return zlibCrc32(data, previous);
}
