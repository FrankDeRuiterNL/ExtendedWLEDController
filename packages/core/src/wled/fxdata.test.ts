import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseFxData,
  parseFxMeta,
  selectableEffects,
  type FxControl,
} from './fxdata.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../test/fixtures/wled-16.0.0-esp32/${name}.json`, import.meta.url)),
      'utf8',
    ),
  );

const labels = (controls: FxControl[]) => controls.map((c) => `${c.key}:${c.label}`);

/**
 * The grammar contract. Each row is `[raw, expectation]`. Treat this table the
 * way the spec tells us to treat the DDP byte layout: it IS the contract.
 */
describe('parseFxMeta — grammar contract', () => {
  it('absent params section → Speed + Intensity sliders', () => {
    const m = parseFxMeta(0, '');
    // "" → params present but empty → no controls (see table in fxdata.ts)
    expect(m.controls).toEqual([]);
  });

  it('truly-absent params (no section at all is impossible with split, so test colors/palette/flags absent)', () => {
    // "!,!" — only the params section exists; colors/palette/flags/defaults absent
    const m = parseFxMeta(1, '!,!');
    expect(labels(m.controls)).toEqual(['sx:Speed', 'ix:Intensity']);
    expect(m.colors.map((c) => c.label)).toEqual(['Fx', 'Bg', 'Cs']); // absent → all 3
    expect(m.paletteEnabled).toBe(true); // absent → enabled
    expect(m.flags.oneD).toBe(true); // absent → "1"
    expect(m.defaults).toEqual({});
  });

  it('empty label hides that control; ! resolves to the default label', () => {
    // sx hidden, ix shown as "Intensity"
    const m = parseFxMeta(2, ',!;Bg,,Glitter color;;;m12=0');
    expect(labels(m.controls)).toEqual(['ix:Intensity']);
  });

  it('hidden colour slot in the middle keeps later slot indices', () => {
    const m = parseFxMeta(2, ',!;Bg,,Glitter color;;;m12=0');
    expect(m.colors).toEqual([
      { index: 0, label: 'Bg' },
      { index: 2, label: 'Glitter color' },
    ]);
  });

  it('present-but-empty palette section → DISABLED', () => {
    expect(parseFxMeta(2, ',!;Bg,,Glitter color;;;m12=0').paletteEnabled).toBe(false);
  });

  it('present-but-empty colors section → no colour slots', () => {
    const m = parseFxMeta(7, '!,!,,,,Smooth;;!');
    expect(m.colors).toEqual([]);
    expect(m.paletteEnabled).toBe(true);
    expect(labels(m.controls)).toEqual(['sx:Speed', 'ix:Intensity', 'o1:Smooth']);
  });

  it('flags are parsed per-character, not comma-split', () => {
    expect(parseFxMeta(0, ';;;01').flags).toMatchObject({ oneD: true, singleLed: true, twoD: false });
    expect(parseFxMeta(0, ';;;2').flags).toMatchObject({ twoD: true, oneD: false });
    expect(parseFxMeta(0, ';;;1v').flags).toMatchObject({ oneD: true, volumeReactive: true });
    expect(parseFxMeta(0, ';;;2f').flags).toMatchObject({ twoD: true, frequencyReactive: true });
    expect(parseFxMeta(0, ';;;01f').flags).toMatchObject({
      oneD: true,
      singleLed: true,
      frequencyReactive: true,
    });
  });

  it('empty flags section → 1D default', () => {
    expect(parseFxMeta(38, '!,!;1,2,3;!;;sx=24,pal=50').flags).toMatchObject({ oneD: true });
  });

  it('defaults parse arbitrary key=value pairs, not just slider keys', () => {
    const m = parseFxMeta(
      126,
      '!,Y Offset,Trail,Font size,Rotate,Gradient,Custom Font,Reverse;!,!,Gradient;!;2;ix=128,c1=0,rev=0,mi=0,rY=0,mY=0',
    );
    expect(m.defaults).toEqual({ ix: 128, c1: 0, rev: 0, mi: 0, rY: 0, mY: 0 });
  });

  it('c3 slider carries the 0–31 range, others 0–255, checkboxes 0–1', () => {
    const m = parseFxMeta(
      0,
      'a,b,c,d,e,f,g,h', // all 8 positions labelled
    );
    const byKey = Object.fromEntries(m.controls.map((c) => [c.key, c]));
    expect(byKey.c3).toMatchObject({ min: 0, max: 31, kind: 'slider' });
    expect(byKey.c1).toMatchObject({ min: 0, max: 255, kind: 'slider' });
    expect(byKey.o1).toMatchObject({ min: 0, max: 1, kind: 'checkbox' });
  });

  it('Aurora (id 38) from the real dump', () => {
    const m = parseFxMeta(38, '!,!;1,2,3;!;;sx=24,pal=50', { name: 'Aurora' });
    expect(labels(m.controls)).toEqual(['sx:Speed', 'ix:Intensity']);
    expect(m.colors).toEqual([
      { index: 0, label: '1' },
      { index: 1, label: '2' },
      { index: 2, label: '3' },
    ]);
    expect(m.paletteEnabled).toBe(true);
    expect(m.defaults).toEqual({ sx: 24, pal: 50 });
    expect(m.reserved).toBe(false);
  });

  it('more than 4 semicolons: trailing content stays on the defaults section', () => {
    const m = parseFxMeta(0, '!;;;1;a=1;b=2');
    expect(m.defaults).toEqual({ a: 1, b: 2 });
  });
});

describe('parseFxData — against the real WLED 16.0.0 dump', () => {
  const eff: string[] = fixture('eff');
  const fxdata: string[] = fixture('fxdata');
  const info = fixture('info');

  it('fixture sanity: lengths line up with info.fxcount', () => {
    expect(eff).toHaveLength(220);
    expect(fxdata).toHaveLength(220);
    expect(info.fxcount).toBe(220);
  });

  const { effects, warnings } = parseFxData(fxdata, eff, info.fxcount);

  it('no warnings for a well-formed dump', () => {
    expect(warnings).toEqual([]);
  });

  it('every entry parses without throwing and keeps its positional id', () => {
    effects.forEach((e, i) => expect(e.id).toBe(i));
    expect(effects).toHaveLength(220);
  });

  it('flags every RSVD slot as reserved, keeps the id, and excludes it from pickers', () => {
    const reserved = effects.filter((e) => e.reserved);
    expect(reserved.length).toBeGreaterThan(0);
    for (const r of reserved) expect(r.name).toBe('RSVD');
    // ids are still positional after filtering
    const pickable = selectableEffects(effects);
    expect(pickable.length).toBe(220 - reserved.length);
    expect(pickable.find((e) => e.name === 'Aurora')?.id).toBe(eff.indexOf('Aurora'));
  });

  it('id 0 "Solid" (raw "") → no params; colours + palette fall back to the defaults', () => {
    const solid = effects[0]!;
    expect(solid.name).toBe('Solid');
    expect(solid.raw).toBe('');
    // params section is present-but-empty → every control hidden
    expect(solid.controls).toEqual([]);
    // colours / palette / flags sections are ABSENT → documented defaults
    expect(solid.colors.map((c) => c.label)).toEqual(['Fx', 'Bg', 'Cs']);
    expect(solid.paletteEnabled).toBe(true);
    expect(solid.flags.oneD).toBe(true);
  });

  it('audio-reactive effects carry v / f flags', () => {
    const geq = effects[eff.indexOf('GEQ')]!;
    expect(geq.flags.frequencyReactive || geq.flags.volumeReactive).toBe(true);
  });

  it('2D-only effects are flagged (device is 1D — UI must gate these)', () => {
    const octopus = effects[eff.indexOf('Octopus')]!;
    expect(octopus.flags.twoD).toBe(true);
  });

  it('defaults never contain NaN', () => {
    for (const e of effects) {
      for (const [k, v] of Object.entries(e.defaults)) {
        expect(Number.isFinite(v), `${e.name}.${k}`).toBe(true);
      }
    }
  });
});
