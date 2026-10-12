/**
 * Read-all-entries functions for each library under comparison. Every
 * function decompresses the data of every file entry, using each library's
 * default options.
 */

import { readFile } from "fs/promises";
import type { Readable } from "stream";
import { ZipReader } from "../src/index.js";
import { BufferSource } from "../src/sources/buffer.js";
import { FileSource } from "../src/sources/file.js";
import { crc32 as jsCrc32 } from "../src/crc-browser.js";
import * as yauzlPromise from "yauzl-promise";
import yauzl from "yauzl";
import { unzipSync } from "fflate";
import { ZipReader as ZipJsReader, Uint8ArrayWriter } from "@zip.js/zip.js";
import AdmZip from "adm-zip";
import JSZip from "jszip";
import unzipper from "unzipper";
import StreamZip from "node-stream-zip";

type Bytes = Uint8Array<ArrayBuffer>;

function toBuffer(data: Bytes): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function consumeStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done);
}

async function consumeNodeStream(stream: Readable) {
  for await (const _ of stream);
}

async function readZipReader(zip: ZipReader) {
  for await (const entry of zip) {
    if (entry.isDirectory) continue;
    await consumeStream(entry.readable());
  }
}

export async function zipReaderBuffer(data: Bytes) {
  await readZipReader(await ZipReader.from(new BufferSource(data)));
}

// zip-reader only passes ArrayBuffer-backed data to crc32
const crc32 = jsCrc32 as (data: Uint8Array, value?: number) => number;

export async function zipReaderBufferJsCrc32(data: Bytes) {
  await readZipReader(await ZipReader.from(new BufferSource(data), { crc32 }));
}

export async function zipReaderFile(path: string) {
  const source = await FileSource.open(path);
  try {
    await readZipReader(await ZipReader.from(source));
  } finally {
    await source.close();
  }
}

async function readYauzlPromise(zip: yauzlPromise.ZipFile) {
  try {
    for await (const entry of zip) {
      if (entry.filename.endsWith("/")) continue;
      await consumeNodeStream(await entry.openReadStream());
    }
  } finally {
    await zip.close();
  }
}

export async function yauzlPromiseBuffer(data: Bytes) {
  await readYauzlPromise(await yauzlPromise.fromBuffer(toBuffer(data)));
}

export async function yauzlPromiseFile(path: string) {
  await readYauzlPromise(await yauzlPromise.open(path));
}

function readYauzl(zip: yauzl.ZipFile): Promise<void> {
  return new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith("/")) return zip.readEntry();
      zip
        .openReadStreamPromise(entry)
        .then(consumeNodeStream)
        .then(() => zip.readEntry(), reject);
    });
    zip.readEntry();
  });
}

export async function yauzlBuffer(data: Bytes) {
  await readYauzl(
    await yauzl.fromBufferPromise(toBuffer(data), { lazyEntries: true }),
  );
}

export async function yauzlFile(path: string) {
  await readYauzl(await yauzl.openPromise(path, { lazyEntries: true }));
}

export function fflateBuffer(data: Bytes) {
  unzipSync(data);
}

export async function fflateFile(path: string) {
  unzipSync(await readFile(path));
}

export async function zipJsBuffer(data: Bytes) {
  const reader = new ZipJsReader(new Response(data).body!);
  for (const entry of await reader.getEntries()) {
    if (entry.directory) continue;
    await entry.getData(new Uint8ArrayWriter());
  }
  await reader.close();
}

function readAdmZip(zip: AdmZip) {
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    entry.getData();
  }
}

export function admZipBuffer(data: Bytes) {
  readAdmZip(new AdmZip(toBuffer(data)));
}

export function admZipFile(path: string) {
  readAdmZip(new AdmZip(path));
}

export async function jszipBuffer(data: Bytes) {
  const zip = await JSZip.loadAsync(data);
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    await file.async("uint8array");
  }
}

export async function jszipFile(path: string) {
  await jszipBuffer(new Uint8Array(await readFile(path)));
}

async function readUnzipper(dir: unzipper.CentralDirectory) {
  for (const file of dir.files) {
    if (file.type === "Directory") continue;
    await file.buffer();
  }
}

export async function unzipperBuffer(data: Bytes) {
  await readUnzipper(await unzipper.Open.buffer(toBuffer(data)));
}

export async function unzipperFile(path: string) {
  await readUnzipper(await unzipper.Open.file(path));
}

export async function nodeStreamZipFile(path: string) {
  const zip = new StreamZip.async({ file: path });
  try {
    for (const entry of Object.values(await zip.entries())) {
      if (entry.isDirectory) continue;
      await zip.entryData(entry);
    }
  } finally {
    await zip.close();
  }
}
