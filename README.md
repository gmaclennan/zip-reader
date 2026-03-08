# zip-reader

[![npm version](https://img.shields.io/npm/v/@gmaclennan/zip-reader.svg)](https://www.npmjs.com/package/@gmaclennan/zip-reader)
[![GitHub CI](https://github.com/gmaclennan/zip-reader/actions/workflows/test.yml/badge.svg)](https://github.com/gmaclennan/zip-reader/actions/workflows/test.yml)

A modern streaming ZIP archive reader for JavaScript that uses the
[Web Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API)
and
[Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API).

## Features

- **Streaming API** - Stream entry data without buffering entire files into
  memory
- **Browser & Node.js** - Works in both environments with the same API
- **Small bundle size** - Tree-shakeable sources and optional Mac archive
  support
- **ZIP64 support** - Automatic handling of large files and archives
- **CRC32 & size validation** - Verifies data integrity on the fly
- **Mac archive support** - Handles faulty ZIPs created by Mac OS Archive
  Utility (opt-in)
- **Custom sources** - Pluggable `RandomAccessSource` interface for any data
  backend

## Installation

```bash
npm install @gmaclennan/zip-reader
```

## Basic Usage

```ts
import { ZipReader } from "@gmaclennan/zip-reader";
import { BufferSource } from "@gmaclennan/zip-reader/buffer-source";

const zipData = new Uint8Array(/* ... */);
const zip = await ZipReader.from(new BufferSource(zipData));

for await (const entry of zip) {
  console.log(entry.name, entry.uncompressedSize);

  if (!entry.isDirectory) {
    const stream = entry.readable();
    // Pipe to a file, process in memory, etc.
  }
}
```

## Sources

`ZipReader.from()` accepts a `RandomAccessSource` — an interface for reading
bytes at arbitrary offsets. Several built-in sources are provided as separate
imports to keep the main bundle small.

### `BufferSource`

Wraps a `Uint8Array` or `ArrayBuffer` for in-memory ZIP reading.

```ts
import { BufferSource } from "@gmaclennan/zip-reader/buffer-source";

const source = new BufferSource(zipBytes);
const zip = await ZipReader.from(source);
```

### `BlobSource`

Wraps a `Blob` for browser-based ZIP reading.

```ts
import { BlobSource } from "@gmaclennan/zip-reader/blob-source";

const response = await fetch("archive.zip");
const blob = await response.blob();
const zip = await ZipReader.from(new BlobSource(blob));
```

### `FileSource`

Reads directly from a file on disk (Node.js only). Efficient for large archives
since it doesn't load the entire file into memory.

```ts
import { FileSource } from "@gmaclennan/zip-reader/file-source";

const source = await FileSource.open("archive.zip");
try {
  const zip = await ZipReader.from(source);
  for await (const entry of zip) {
    // ...
  }
} finally {
  await source.close();
}
```

### Custom Sources

Implement the `RandomAccessSource` interface for any data backend:

```ts
import type { RandomAccessSource } from "@gmaclennan/zip-reader";

class HttpRangeSource implements RandomAccessSource {
  readonly size: number;
  readonly #url: string;

  constructor(url: string, size: number) {
    this.#url = url;
    this.size = size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const response = await fetch(this.#url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    return new Uint8Array(await response.arrayBuffer());
  }
}
```

## Mac OS Archive Utility Support

Mac OS Archive Utility creates faulty ZIP files that truncate entry counts and
offsets to 16/32 bits instead of using ZIP64. This module can detect and correct
these issues.

Mac archive support is a separate import so it doesn't increase bundle size for
applications that don't need it.

```ts
import { ZipReader } from "@gmaclennan/zip-reader";
import { BufferSource } from "@gmaclennan/zip-reader/buffer-source";
import { macArchive } from "@gmaclennan/zip-reader/mac";

const zip = await ZipReader.from(new BufferSource(zipData), {
  macArchiveFactory: macArchive,
});

for await (const entry of zip) {
  // Works correctly even for Mac archives with >65535 entries
}
```

## API Reference

### `ZipReader`

The main class for reading ZIP archives.

#### `ZipReader.from(source, options?)`

Create a `ZipReader` from a `RandomAccessSource`.

**Parameters:**

- `source: RandomAccessSource` - The data source to read from
- `options?: ZipReaderOptions` - Optional configuration

**Returns:** `Promise<ZipReader>`

```ts
const zip = await ZipReader.from(source, {
  validateCrc32: true, // default
  validateEntrySizes: true, // default
  validateFilenames: true, // default
  uniqueEntryOffsets: true, // default
  macArchiveFactory: macArchive, // optional, import from "@gmaclennan/zip-reader/mac"
});
```

#### Properties

##### `comment: string`

The ZIP archive comment.

##### `isZip64: boolean`

Whether the archive uses ZIP64 format.

#### Methods

##### `[Symbol.asyncIterator](): AsyncGenerator<ZipEntry>`

Iterate over all entries in the archive.

```ts
for await (const entry of zip) {
  console.log(entry.name);
}
```

### `ZipEntry`

Represents a single entry in the ZIP archive.

#### Properties

- `name: string` - Entry name including internal path
- `comment: string` - Entry comment
- `compressedSize: number` - Compressed size in bytes
- `uncompressedSize: number` - Uncompressed size in bytes
- `crc32: number` - CRC32 checksum
- `compressionMethod: number` - Compression method (0 = stored, 8 = deflate)
- `lastModified: Date` - Last modification date
- `isDirectory: boolean` - Whether this entry is a directory
- `isCompressed: boolean` - Whether this entry is compressed
- `isEncrypted: boolean` - Whether this entry is encrypted
- `zip64: boolean` - Whether this entry uses ZIP64 format
- `externalAttributes: number` - External file attributes
- `versionMadeBy: number` - Version made by field
- `generalPurposeBitFlag: number` - General purpose bit flag
- `extraFields: ReadonlyArray<{ id: number; data: Uint8Array }>` - Extra fields

#### Methods

##### `readable(options?): ReadableStream<Uint8Array>`

Get a `ReadableStream` of the entry's data. By default, compressed entries are
decompressed and CRC32 is validated.

**Parameters:**

- `options.decompress?: boolean` - Decompress the data (default: `true` for
  compressed entries)
- `options.validateCrc32?: boolean` - Validate CRC32 checksum (default: `true`)

**Returns:** `ReadableStream<Uint8Array>`

```ts
// Read decompressed data (default)
const stream = entry.readable();

// Read raw compressed data
const rawStream = entry.readable({ decompress: false });

// Skip CRC32 validation
const fastStream = entry.readable({ validateCrc32: false });
```

**Example — read entry to string:**

```ts
for await (const entry of zip) {
  if (entry.isDirectory) continue;

  const stream = entry.readable();
  const response = new Response(stream);
  const text = await response.text();
  console.log(`${entry.name}: ${text}`);
}
```

**Example — save to file (Node.js):**

```ts
import { createWriteStream } from "fs";
import { Writable } from "stream";

for await (const entry of zip) {
  if (entry.isDirectory) continue;

  const stream = entry.readable();
  await stream.pipeTo(Writable.toWeb(createWriteStream(entry.name)));
}
```

### `ZipReaderOptions`

**Properties:**

- `crc32?: (data: Uint8Array, value?: number) => number` - Custom CRC32
  function. Defaults to `zlib.crc32` on Node.js and a pure JavaScript
  implementation in browsers.
- `validateCrc32?: boolean` - Validate CRC32 checksums when streaming entry
  data. Default: `true`
- `validateEntrySizes?: boolean` - Validate uncompressed entry sizes. Default:
  `true`
- `validateFilenames?: boolean` - Validate filenames for dangerous paths
  (absolute paths, `..` traversal). Default: `true`
- `uniqueEntryOffsets?: boolean` - Require each entry to have a unique local
  file header offset. Rejects archives where multiple Central Directory entries
  point to the same Local File Header — the key technique in overlapping ZIP
  bombs. Set to `false` for archives that legitimately share file data (e.g.
  tile maps with deduplicated tiles). Default: `true`
- `macArchiveFactory?: MacArchiveFactory` - Factory for Mac OS Archive Utility
  support. Import from `"@gmaclennan/zip-reader/mac"`.

### `RandomAccessSource`

Interface for providing random access to ZIP data.

**Properties:**

- `size: number` - Total size of the source in bytes

**Methods:**

- `read(offset: number, length: number): Promise<Uint8Array>` - Read `length`
  bytes starting at `offset`
- `close?(): Promise<void>` - Optional cleanup

## Safety and edge-case handling

ZIP is a decades-old format with many quirks, ambiguities, and
implementation-specific behaviors. This library tries to handle the ones we know
about — but it's not exhaustive. If you find an edge case we've missed, please
open an issue.

### Handled by default

| Category                            | What's checked                                                                        | Details                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Path traversal**                  | Rejects `..` segments, absolute paths, backslashes, Windows drive letters, null bytes | Prevents directory escape and path truncation attacks. Disable with `validateFilenames: false`.                                                                           |
| **ZIP bombs (overlapping entries)** | Rejects multiple CD entries pointing to the same local file header                    | Detects the [overlapping file data](https://www.bamsoftware.com/hacks/zipbomb/) technique. Disable with `uniqueEntryOffsets: false` for legitimate use cases (see below). |
| **ZIP bombs (size mismatch)**       | Validates decompressed output against declared `uncompressedSize`                     | A single entry cannot silently decompress to more than its declared size. Disable with `validateEntrySizes: false`.                                                       |
| **CRC32 validation**                | Validates checksum on decompressed data                                               | Catches corruption and tampered content. Disable with `validateCrc32: false`.                                                                                             |
| **Structural consistency**          | Entry count vs. Central Directory size, CD bounds vs. EOCD offset                     | Rejects archives where the EOCD metadata is internally inconsistent, catching malformed files early.                                                                      |
| **ZIP64 safe integers**             | Rejects 64-bit values above `Number.MAX_SAFE_INTEGER`                                 | Prevents silent precision loss that could cause incorrect offsets or sizes.                                                                                               |
| **Source bounds checking**          | All built-in sources validate read offsets                                            | Throws a clear `RangeError` rather than returning silently short data.                                                                                                    |
| **Strong encryption**               | Rejected at parse time                                                                | Throws rather than returning garbage data.                                                                                                                                |
| **Multi-disk archives**             | Rejected at parse time                                                                | Not supported; detected and rejected cleanly.                                                                                                                             |
| **Mac OS Archive Utility**          | Detects and corrects truncated 32-bit values                                          | Mac's built-in archiver creates non-conformant ZIPs with truncated sizes, offsets, and entry counts. Opt-in via `macArchiveFactory` option.                               |

### What this library does _not_ do

This is a low-level reading library, not an extraction tool. It doesn't write
files to disk, so some concerns are the caller's responsibility:

- **Symlink attacks** — ZIP entries can represent symlinks via external
  attributes, but this library treats all entries as regular files/directories.
  If you create symlinks on disk, validate their targets yourself.
- **Total output size limits** — Each entry's size is validated individually,
  but if you extract an entire archive you should track cumulative bytes written
  and enforce your own limit.
- **Filename encoding heuristics** — When the UTF-8 flag (general purpose
  bit 11) is not set, filenames are decoded as CP437 per the spec. Some tools
  (notably Mac's Archive Utility) write UTF-8 without setting this flag. The
  library does not attempt to guess the encoding.

## ZIP64 Support

The library automatically handles ZIP64 format when present:

- Archives with more than 65,535 entries
- Files larger than 4GB
- Central directory larger than 4GB
- Central directory offset greater than 4GB

No special configuration is needed — it's handled automatically.

## Error Handling

```ts
try {
  const zip = await ZipReader.from(source);
  for await (const entry of zip) {
    const stream = entry.readable();
    const response = new Response(stream);
    const data = await response.arrayBuffer();
  }
} catch (error) {
  console.error("Failed to read ZIP:", error);
}
```

Common errors:

- `"End of Central Directory Record not found"` - Not a valid ZIP file
- `"CRC32 validation failed"` - Data corruption detected
- `"Decryption is not supported"` - Entry is encrypted
- `"Strong encryption is not supported"` - Entry uses strong encryption
- `"Multi-disk ZIP files are not supported"` - Split archives

## License

MIT
