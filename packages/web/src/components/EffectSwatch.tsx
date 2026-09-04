import { useEffect, useRef } from 'react';
import { Box } from '@mui/material';
import { blend, type EffectDef, type ParamValues } from '@ewc/core';

const W = 48;
const H = 20;

/**
 * A small, self-contained looping preview of one effect — composited over
 * black with the same {@link blend} the Scenes compositor uses, so a
 * partial-alpha effect (Fire, Comet, Scanner, Sparkle, …) reads correctly
 * instead of showing raw un-blended colour. Free-runs its own clock; used as
 * a gallery thumbnail, not synced to anything else on the page.
 */
export function EffectSwatch({ effect, params }: { effect: EffectDef; params: ParamValues }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = W;
    canvas.height = H;
    const img = ctx.createImageData(W, H);
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = (now - start) / 1000;
      const data = img.data;
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const x = (px + 0.5) / W;
          const y = (py + 0.5) / H;
          const c = blend([0, 0, 0], effect.render(x, y, t, params), 'normal');
          const o = (py * W + px) * 4;
          data[o] = c[0];
          data[o + 1] = c[1];
          data[o + 2] = c[2];
          data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [effect, params]);

  return (
    <Box
      component="canvas"
      ref={canvasRef}
      sx={{
        width: '100%',
        height: 64,
        borderRadius: 1,
        display: 'block',
        imageRendering: 'pixelated',
        bgcolor: '#000',
      }}
    />
  );
}
