// The pixel size of a PNG, JPEG, GIF or WebP from its first bytes, so the page can keep room for
// an image before it loads. Null when the bytes do not say.
export function imageSize(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  try {
    if (ascii(1, 3) === 'PNG') return size(view.getUint32(16), view.getUint32(20));
    if (ascii(0, 3) === 'GIF') return size(view.getUint16(6, true), view.getUint16(8, true));
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return webpSize(view, ascii(12, 4));
    if (view.getUint16(0) === 0xffd8) return jpegSize(view);
  } catch {
    return null;
  }
  return null;
}

const size = (width: number, height: number) =>
  width > 0 && height > 0 ? { width, height } : null;

function webpSize(view: DataView, chunk: string) {
  if (chunk === 'VP8 ')
    return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    const width = view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16);
    const height = view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16);
    return size(width + 1, height + 1);
  }
  return null;
}

// Walks the JPEG segments to the first start-of-frame, which holds the size. A photo turned by
// its EXIF orientation shows turned in the browser, so its sides swap.
function jpegSize(view: DataView) {
  let offset = 2;
  let turned = false;
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xe1) turned = exifTurnsSideways(view, offset + 4);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return turned ? size(height, width) : size(width, height);
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

const orientationTag = 0x0112;

// Orientations 5 to 8 turn the picture by a quarter.
function exifTurnsSideways(view: DataView, start: number) {
  if (view.getUint32(start) !== 0x45786966) return false;
  const tiff = start + 6;
  const little = view.getUint16(tiff) === 0x4949;
  const entries = tiff + view.getUint32(tiff + 4, little);
  const count = view.getUint16(entries, little);
  for (let index = 0; index < count; index++) {
    const entry = entries + 2 + index * 12;
    if (view.getUint16(entry, little) === orientationTag) {
      return view.getUint16(entry + 8, little) >= 5;
    }
  }
  return false;
}
