import { describe, expect, it } from 'vitest';
import { encodePixelRowGif } from './bakeService.js';

/** Read the logical-screen width/height from a GIF89a byte buffer. */
function gifSize(bytes: Uint8Array): { sig: string; w: number; h: number } {
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  const w = bytes[6]! | (bytes[7]! << 8);
  const h = bytes[8]! | (bytes[9]! << 8);
  return { sig, w, h };
}

describe('encodePixelRowGif', () => {
  it('emits a GIF89a whose logical screen is width × 1', () => {
    const px = ['FF0000', '00FF00', '0000FF', null, 'FFFFFF'];
    const gif = encodePixelRowGif(px);
    const { sig, w, h } = gifSize(gif);
    expect(sig).toBe('GIF89a');
    expect(w).toBe(5);
    expect(h).toBe(1);
    // trailer byte
    expect(gif[gif.length - 1]).toBe(0x3b);
  });

  it('treats null as black and still produces a valid file', () => {
    const gif = encodePixelRowGif([null, null, null]);
    expect(gifSize(gif)).toMatchObject({ sig: 'GIF89a', w: 3, h: 1 });
  });

  it('never returns an empty buffer for a 1-pixel row', () => {
    const gif = encodePixelRowGif(['123456']);
    expect(gif.length).toBeGreaterThan(20);
    expect(gifSize(gif)).toMatchObject({ w: 1, h: 1 });
  });
});
