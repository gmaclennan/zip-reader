/**
 * Creates ZIP fixtures using zip-writer for benchmarks.
 */

import { ZipWriter } from "zip-writer";
import { readableFromBytes } from "zip-writer/readable-from-bytes.js";

function createContent(index: number, size: number): Uint8Array {
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
  fileSize: number
): Promise<Uint8Array> {
  const zipWriter = new ZipWriter();

  const chunks: Uint8Array[] = [];
  const consumePromise = zipWriter.readable.pipeTo(
    new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    })
  );

  for (let i = 0; i < fileCount; i++) {
    const name = `file-${i.toString().padStart(6, "0")}.txt`;
    const content = createContent(i, fileSize);
    await zipWriter.addEntry({
      name,
      readable: readableFromBytes(content),
    });
  }

  zipWriter.finalize();
  await consumePromise;

  let totalLength = 0;
  for (const c of chunks) totalLength += c.byteLength;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.byteLength;
  }
  return result;
}
