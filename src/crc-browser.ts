/**
 * The JavaScript implementation of CRC32 is a version of the slice-by-16 algorithm
 * as implemented by Stephan Brumme, see https://github.com/stbrumme/crc32.
 *
 * Copyright (c) 2011-2016 Stephan Brumme
 *
 * This software is provided 'as-is', without any express or implied warranty.
 * In no event will the authors be held liable for any damages arising from the
 * use of this software.
 *
 * Permission is granted to anyone to use this software for any purpose,
 * including commercial applications, and to alter it and redistribute it freely,
 * subject to the following restrictions:
 *
 * 1. The origin of this software must not be misrepresented; you must not claim
 *    that you wrote the original software.
 *    If you use this software in a product, an acknowledgment in the product
 *    documentation would be appreciated but is not required.
 * 2. Altered source versions must be plainly marked as such, and must not be
 *    misrepresented as being the original software.
 * 3. This notice may not be removed or altered from any source distribution.
 */

/**
 * From https://github.com/holepunchto/crc-universal/blob/main/lookup.js
 * Licensed under Apache-2.0
 */

const lookup = new Array(16) as Uint32Array<ArrayBuffer>[];

for (let i = 0; i < 16; i++) {
  lookup[i] = new Uint32Array(0x100);
}

for (let i = 0; i <= 0xff; i++) {
  let crc = i;

  for (let j = 0; j < 8; j++) {
    crc = (crc >>> 1) ^ ((crc & 1) * 0xedb88320);
  }

  lookup[0][i] = crc;
}

for (let i = 0; i <= 0xff; i++) {
  for (let j = 1; j < 16; j++) {
    lookup[j][i] =
      (lookup[j - 1][i] >>> 8) ^ lookup[0][lookup[j - 1][i] & 0xff];
  }
}

/**
 * Computes a 32-bit Cyclic Redundancy Check checksum of data. If value is
 * specified, it is used as the starting value of the checksum, otherwise, 0 is
 * used as the starting value.
 *
 * @param data - The input data to compute the checksum for.
 * @param value -  An optional starting value. It must be a 32-bit unsigned integer. Default: 0
 * @returns The computed CRC32 checksum.
 */
export function crc32(
  data: Uint8Array<ArrayBuffer>,
  value: number = 0
): number {
  let crc = ~value;
  let i = 0;
  let length = data.byteLength;

  while (length >= 16) {
    crc =
      lookup[15][data[i++] ^ (crc & 0xff)] ^
      lookup[14][data[i++] ^ ((crc >>> 8) & 0xff)] ^
      lookup[13][data[i++] ^ ((crc >>> 16) & 0xff)] ^
      lookup[12][data[i++] ^ (crc >>> 24)] ^
      lookup[11][data[i++]] ^
      lookup[10][data[i++]] ^
      lookup[9][data[i++]] ^
      lookup[8][data[i++]] ^
      lookup[7][data[i++]] ^
      lookup[6][data[i++]] ^
      lookup[5][data[i++]] ^
      lookup[4][data[i++]] ^
      lookup[3][data[i++]] ^
      lookup[2][data[i++]] ^
      lookup[1][data[i++]] ^
      lookup[0][data[i++]];

    length -= 16;
  }

  while (length-- > 0) {
    crc = (crc >>> 8) ^ lookup[0][(crc & 0xff) ^ data[i++]];
  }

  return ~crc >>> 0;
}
