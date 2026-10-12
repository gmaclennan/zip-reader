/**
 * Creates ZIP fixtures using zip-writer for benchmarks.
 */

import { ZipWriter } from "zip-writer";
import { readableFromBytes } from "zip-writer/readable-from-bytes.js";

function createContent(index: number, size: number): Uint8Array<ArrayBuffer> {
  const pattern = `Line ${index}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`;
  const patternBytes = new TextEncoder().encode(pattern);
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buffer[i] = patternBytes[i % patternBytes.length];
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
    const name = `file-${i.toString().padStart(6, "0")}.txt`;
    const content = createContent(i, fileSize);
    await zipWriter.addEntry({
      name,
      readable: readableFromBytes(content),
    });
  }

  zipWriter.finalize();
  return zipBytes;
}
