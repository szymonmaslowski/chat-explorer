import { describe, expect, it } from 'vitest';
import { imageSize } from '../src/files/image-size.js';

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part,
    ),
  );
const be32 = (value: number) => [
  value >>> 24,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
const be16 = (value: number) => [value >>> 8, value & 255];
const le16 = (value: number) => [value & 255, value >>> 8];
const le24 = (value: number) => [value & 255, (value >>> 8) & 255, value >>> 16];

describe('image sizes', () => {
  it('reads a PNG', () => {
    const png = bytes([0x89], 'PNG', [13, 10, 26, 10], be32(13), 'IHDR', be32(1170), be32(2532));
    expect(imageSize(png)).toEqual({ width: 1170, height: 2532 });
  });

  it('reads a GIF', () => {
    expect(imageSize(bytes('GIF89a', le16(320), le16(200)))).toEqual({ width: 320, height: 200 });
  });

  it('reads a JPEG past its other segments', () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0],
      be16(16),
      new Array(14).fill(0),
      [0xff, 0xc0],
      be16(17),
      [8],
      be16(3024),
      be16(4032),
      new Array(10).fill(0),
    );
    expect(imageSize(jpeg)).toEqual({ width: 4032, height: 3024 });
  });

  it('swaps the sides of a JPEG its EXIF orientation turns', () => {
    const exif = bytes(
      'Exif',
      [0, 0],
      'MM',
      [0, 42],
      be32(8),
      be16(1),
      be16(0x0112),
      be16(3),
      be32(1),
      be16(6),
      [0, 0],
    );
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe1],
      be16(2 + exif.length),
      [...exif],
      [0xff, 0xc0],
      be16(17),
      [8],
      be16(3024),
      be16(4032),
      new Array(10).fill(0),
    );
    expect(imageSize(jpeg)).toEqual({ width: 3024, height: 4032 });
  });

  it('reads an extended WebP', () => {
    const webp = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBP',
      'VP8X',
      be32(10),
      [0, 0, 0, 0],
      le24(799),
      le24(599),
    );
    expect(imageSize(webp)).toEqual({ width: 800, height: 600 });
  });

  it('says nothing about other or cut-off bytes', () => {
    expect(imageSize(bytes('hello'))).toBeNull();
    expect(imageSize(bytes([0x89], 'PNG'))).toBeNull();
  });
});
