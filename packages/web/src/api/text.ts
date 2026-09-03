import { MEDIA_MAX_EDGE, TEXT_FONTS, textRenderHash, type TextLayerSpec } from '@ewc/core';

/** What a rasterise + upload produces — merge this back into the layer's text spec. */
export interface RasterizedText {
  assetId: string;
  naturalWidth: number;
  naturalHeight: number;
  renderHash: string;
}

const fontStack = (fontId: string): string =>
  TEXT_FONTS.find((f) => f.id === fontId)?.stack ?? TEXT_FONTS[0]!.stack;

function cssFont(spec: TextLayerSpec): string {
  const style = spec.italic ? 'italic ' : '';
  const weight = spec.bold ? '700 ' : '400 ';
  return `${style}${weight}${spec.sizePx}px ${fontStack(spec.fontId)}`;
}

/**
 * Make sure the chosen face is actually downloaded before we draw — `fillText`
 * with a pending `@font-face` silently falls back to a default font and we'd
 * upload that as if it were correct.
 */
async function ensureFont(spec: TextLayerSpec): Promise<void> {
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  try {
    await fonts.load(cssFont(spec), spec.value || 'Ag');
  } catch {
    /* offline / face missing — carry on with whatever the browser resolves */
  }
}

function rasterize(spec: TextLayerSpec): { rgba: Uint8ClampedArray; width: number; height: number } {
  const lines = (spec.value || ' ').split('\n');
  const size = spec.sizePx;
  const pad = Math.ceil(size * 0.28); // room for descenders, italic overhang, strike
  const lineHeight = Math.ceil(size * 1.35);

  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) throw new Error('canvas 2d context unavailable');
  probe.font = cssFont(spec);
  let textW = 1;
  for (const ln of lines) textW = Math.max(textW, probe.measureText(ln).width);

  const w = Math.max(1, Math.ceil(textW) + pad * 2);
  const h = Math.max(1, lineHeight * lines.length + pad * 2);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.font = cssFont(spec);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const [r, g, b] = spec.color ?? [255, 255, 255];
  ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;

  lines.forEach((ln, i) => {
    const cy = pad + lineHeight * i + lineHeight / 2;
    ctx.fillText(ln, pad, cy);
    if (spec.strikethrough && ln.trim()) {
      const m = ctx.measureText(ln).width;
      ctx.fillRect(pad, Math.round(cy - size * 0.05), m, Math.max(1, Math.round(size * 0.09)));
    }
  });

  // Downscale so the long edge is ≤ MEDIA_MAX_EDGE, exactly like an uploaded image.
  const scale = Math.min(1, MEDIA_MAX_EDGE / Math.max(w, h));
  if (scale >= 1) {
    return { rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  }
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('canvas 2d context unavailable');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, sw, sh);
  return { rgba: sctx.getImageData(0, 0, sw, sh).data, width: sw, height: sh };
}

/**
 * Rasterise `spec` to RGBA in the browser and upload it as an `'image'` media
 * asset (the same endpoint image layers use). Both the preview and the DDP loop
 * then read the string back through the normal media path.
 */
export async function rasterizeAndUploadText(spec: TextLayerSpec): Promise<RasterizedText> {
  await ensureFont(spec);
  const { rgba, width, height } = rasterize(spec);
  const body = new Uint8Array(rgba.length);
  body.set(rgba);
  const res = await fetch(`/api/media?w=${width}&h=${height}&name=${encodeURIComponent('text')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: body.buffer as ArrayBuffer,
  });
  const raw = await res.text();
  const json = raw ? JSON.parse(raw) : undefined;
  if (!res.ok) throw new Error(json?.error?.message ?? `text render failed (HTTP ${res.status})`);
  return {
    assetId: json.media.assetId as string,
    naturalWidth: width,
    naturalHeight: height,
    renderHash: textRenderHash(spec),
  };
}
