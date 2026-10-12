/**
 * Creates ZIP fixtures using zip-writer for benchmarks.
 *
 * Entries alternate between text, which compresses about 3:1 like typical
 * prose or source code, and random bytes, which don't compress, like images or
 * already-compressed files. Content is seeded, so fixtures are reproducible.
 */

import { ZipWriter } from "zip-writer";
import { readableFromBytes } from "zip-writer/readable-from-bytes.js";

const VOCABULARY_SIZE = 2000;
// Zipf exponent for word frequency; with this vocabulary it gives ~3:1 deflate
const ZIPF_EXPONENT = 1.1;

/** xorshift32 */
function createRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function createText(seed: number, size: number): Uint8Array<ArrayBuffer> {
  const random = createRandom(seed);
  const vocabulary = Array.from({ length: VOCABULARY_SIZE }, () => {
    let word = "";
    const length = 2 + Math.floor(random() * 8);
    for (let i = 0; i < length; i++) {
      word += String.fromCharCode(97 + Math.floor(random() * 26));
    }
    return word;
  });
  const cumulative: number[] = [];
  let total = 0;
  for (let rank = 1; rank <= VOCABULARY_SIZE; rank++) {
    total += 1 / rank ** ZIPF_EXPONENT;
    cumulative.push(total);
  }

  const encoder = new TextEncoder();
  const buffer = new Uint8Array(size);
  let offset = 0;
  let lineLength = 0;
  while (offset < size) {
    const target = random() * total;
    let lo = 0;
    let hi = VOCABULARY_SIZE - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    const word = vocabulary[lo]!;
    lineLength += word.length + 1;
    const separator = lineLength > 72 ? ".\n" : " ";
    if (separator !== " ") lineLength = 0;
    offset += encoder.encodeInto(
      word + separator,
      buffer.subarray(offset),
    ).written;
  }
  return buffer;
}

function createBinary(seed: number, size: number): Uint8Array<ArrayBuffer> {
  const random = createRandom(seed);
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buffer[i] = (random() * 256) | 0;
  }
  return buffer;
}

export async function createFixtureZip(
  fileCount: number,
  fileSize: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const zipWriter = new ZipWriter();
  const zipBytes = new Response(zipWriter.readable).bytes();
  // Avoid an unhandled rejection if addEntry() throws before zipBytes is awaited
  zipBytes.catch(() => {});

  for (let i = 0; i < fileCount; i++) {
    const isText = i % 2 === 0;
    const name = `file-${i.toString().padStart(6, "0")}.${isText ? "txt" : "bin"}`;
    const content = isText
      ? createText(i + 1, fileSize)
      : createBinary(i + 1, fileSize);
    await zipWriter.addEntry({
      name,
      readable: readableFromBytes(content),
    });
  }

  zipWriter.finalize();
  return zipBytes;
}
