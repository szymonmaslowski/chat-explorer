import { describe, expect, it } from 'vitest';
import { insertText } from '../src/lib/insert-text';
import { encodeWav } from '../src/lib/wav';

describe('WAV encoding', () => {
  it('writes a 16-bit mono header and clamped samples', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 0.5, -1, 2]), 16_000));
    const ascii = (offset: number) =>
      String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      0, 16383, -32767, 32767,
    ]);
  });
});

describe('dictated text', () => {
  it('lands at the cursor with spaces around it', () => {
    expect(insertText('', 0, 'Hello.')).toBe('Hello.');
    expect(insertText('Start', 5, 'more')).toBe('Start more');
    expect(insertText('Start end', 6, 'middle')).toBe('Start middle end');
    expect(insertText('Line\n', 5, 'next')).toBe('Line\nnext');
  });
});
