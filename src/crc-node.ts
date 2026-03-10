// @ts-nocheck
import zlib from "node:zlib";
import { crc32 as crc32Js } from "./crc-browser.js";

export function crc32(data: Uint8Array, previous?: number): number {
  // Node 18 doesn't have a built-in crc32, so fallback to the JS implementation
  if ("crc32" in zlib) {
    return zlib.crc32(data, previous);
  } else {
    return crc32Js(data, previous);
  }
}
