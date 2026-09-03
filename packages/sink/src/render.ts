/** Minimal ANSI truecolor renderer for the sink's terminal preview. */

const RESET = '\x1b[0m';
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

export interface RenderOptions {
  format: 'rgb' | 'rgbw';
  matrix: { w: number; h: number } | null;
  /** Terminal columns available. */
  width: number;
}

function pixelAt(buf: Uint8Array, idx: number, bpl: number): [number, number, number] {
  const o = idx * bpl;
  let r = buf[o] ?? 0;
  let g = buf[o + 1] ?? 0;
  let b = buf[o + 2] ?? 0;
  if (bpl === 4) {
    const w = buf[o + 3] ?? 0; // fold white into RGB for display
    r = Math.min(255, r + w);
    g = Math.min(255, g + w);
    b = Math.min(255, b + w);
  }
  return [r, g, b];
}

/** Render the current frame buffer to a string block (no trailing newline). */
export function renderFrame(buf: Uint8Array, ledCount: number, opts: RenderOptions): string {
  const bpl = opts.format === 'rgbw' ? 4 : 3;

  if (opts.matrix) {
    const { w, h } = opts.matrix;
    const lines: string[] = [];
    // Two matrix rows per text row via the ▀ half-block.
    for (let y = 0; y < h; y += 2) {
      let line = '';
      for (let x = 0; x < w; x++) {
        const top = pixelAt(buf, y * w + x, bpl);
        const bot = y + 1 < h ? pixelAt(buf, (y + 1) * w + x, bpl) : ([0, 0, 0] as [number, number, number]);
        line += `${bg(bot[0], bot[1], bot[2])}${fg(top[0], top[1], top[2])}▀`;
      }
      lines.push(line + RESET);
    }
    return lines.join('\n');
  }

  // Strip: one row, downsampled (averaged) to terminal width.
  const cells = Math.max(1, Math.min(ledCount, opts.width));
  let line = '';
  for (let c = 0; c < cells; c++) {
    const from = Math.floor((c / cells) * ledCount);
    const to = Math.max(from + 1, Math.floor(((c + 1) / cells) * ledCount));
    let r = 0, g = 0, b = 0;
    for (let i = from; i < to; i++) {
      const p = pixelAt(buf, i, bpl);
      r += p[0]; g += p[1]; b += p[2];
    }
    const n = to - from;
    line += `${bg(Math.round(r / n), Math.round(g / n), Math.round(b / n))} `;
  }
  return line + RESET;
}
