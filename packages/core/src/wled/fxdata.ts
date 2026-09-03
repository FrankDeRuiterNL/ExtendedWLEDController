/**
 * Parser for `/json/fxdata` — WLED's per-effect UI metadata.
 *
 * Each entry is one string, positionally aligned with `/json/eff` and
 * `/json/fxdata` both having length `info.fxcount`.
 *
 * Grammar (verified against firmware docs + a real WLED 16.0.0 dump):
 *
 *   <params> ; <colors> ; <palette> ; <flags> ; <defaults>
 *
 * The whole string is split on ";". A trailing section may be entirely absent
 * (fewer semicolons); a section may also be present but empty ("").
 * **These two cases differ** and the difference is the whole ballgame:
 *
 *   ┌───────────┬──────────────────────────┬───────────────────────────────┐
 *   │ section   │ ABSENT (no such segment) │ PRESENT BUT EMPTY ("")         │
 *   ├───────────┼──────────────────────────┼───────────────────────────────┤
 *   │ params    │ Speed + Intensity        │ "".split(",") → [""] →         │
 *   │           │ sliders (default labels) │ every control hidden           │
 *   │ colors    │ all 3 slots (Fx, Bg, Cs) │ [""]  → every colour slot      │
 *   │           │                          │ hidden                        │
 *   │ palette   │ enabled                  │ DISABLED (spec is explicit)    │
 *   │ flags     │ "1" (1D)                 │ "1" (1D) — same as absent      │
 *   │ defaults  │ none                     │ none — same as absent          │
 *   └───────────┴──────────────────────────┴───────────────────────────────┘
 *
 * The "present but empty" rows for params/colors are not stated verbatim in the
 * spec — they fall out of the documented rules ("empty label hides that
 * control", "missing position hides") once you treat "" as an explicit empty
 * label list. The palette row IS explicit ("`!` enables ... empty disables ...
 * Missing means enabled"), which is what tipped us toward this reading for the
 * other sections. Cross-checked against the reference dump:
 *   - id 0 "Solid" = ""            → no controls, no colours, palette default(on)
 *   - id 38 "Aurora" = "!,!;1,2,3;!;;sx=24,pal=50"
 *   - id ~101 "Solid Glitter" = ",!;Bg,,Glitter color;;;m12=0"
 *     → intensity only; colour slots 0 & 2 (slot 1 hidden); palette DISABLED
 *
 * If a future firmware dump contradicts this, change it here and nowhere else.
 */

// --- Control model -----------------------------------------------------------

export type FxControlKey = 'sx' | 'ix' | 'c1' | 'c2' | 'c3' | 'o1' | 'o2' | 'o3';
export type FxControlKind = 'slider' | 'checkbox';

export interface FxControl {
  key: FxControlKey;
  kind: FxControlKind;
  /** Display label (resolved: `!` → default, raw label otherwise). */
  label: string;
  /** Inclusive slider range. Checkboxes report 0/1. */
  min: number;
  max: number;
}

export interface FxColorSlot {
  /** Slot index 0..2. Preserved even when earlier slots are hidden. */
  index: 0 | 1 | 2;
  label: string;
}

export interface FxFlags {
  /** Optimised for 1D. */
  oneD: boolean;
  /** Requires a 2D matrix — falls back to Solid on 1D strips. */
  twoD: boolean;
  /** Requires 3D. */
  threeD: boolean;
  /** Volume-reactive (needs the AudioReactive usermod). */
  volumeReactive: boolean;
  /** Frequency-reactive (needs the AudioReactive usermod). */
  frequencyReactive: boolean;
  /** Works on a single LED. */
  singleLed: boolean;
}

export interface FxMeta {
  /** Effect id — the index in `/json/eff`. Stable, positional. */
  id: number;
  /** The raw metadata string. */
  raw: string;
  /** Effect name from `/json/eff`, if provided to the parser. */
  name?: string;
  /** Visible sliders/checkboxes, in slot order (sx, ix, c1, c2, c3, o1, o2, o3). */
  controls: FxControl[];
  /** Visible colour slots. */
  colors: FxColorSlot[];
  /** Whether the palette selector applies to this effect. */
  paletteEnabled: boolean;
  flags: FxFlags;
  /**
   * Values applied when the effect is selected (NOT on state load).
   * Keys are arbitrary state/segment fields, not only sx/ix/c*: the reference
   * dump has `rev=0`, `mi=0`, `pal=50`, `m12=1`, `si=0`, etc.
   */
  defaults: Record<string, number>;
  /**
   * True when the name is `RSVD` or `-` — a reserved/unsupported slot that
   * falls back to Solid if called. Filter these from pickers but keep the id.
   */
  reserved: boolean;
}

// --- Constants -------------------------------------------------------------

const PARAM_KEYS: readonly FxControlKey[] = ['sx', 'ix', 'c1', 'c2', 'c3', 'o1', 'o2', 'o3'];
const PARAM_KINDS: readonly FxControlKind[] = [
  'slider', 'slider', 'slider', 'slider', 'slider', 'checkbox', 'checkbox', 'checkbox',
];
/** Default label for each param position when the metadata says `!`. */
const PARAM_DEFAULT_LABELS: readonly string[] = [
  'Speed', 'Intensity', 'Custom 1', 'Custom 2', 'Custom 3', 'Option 1', 'Option 2', 'Option 3',
];
/** Slider ranges. c3 is a 5-bit field (0–31); the rest are 0–255. */
const PARAM_RANGES: readonly [number, number][] = [
  [0, 255], [0, 255], [0, 255], [0, 255], [0, 31], [0, 1], [0, 1], [0, 1],
];

const COLOR_DEFAULT_LABELS: readonly string[] = ['Fx', 'Bg', 'Cs'];

const RESERVED_NAMES = new Set(['RSVD', '-']);

/**
 * Default params section when the section is entirely absent.
 *
 * Note: with `String.prototype.split(';')` the params slot is never actually
 * `undefined` (`''.split(';')` → `['']`), so in practice a present-but-empty
 * params section — which yields no controls — is what an empty fxdata string
 * produces. This stays for completeness of the documented contract table and in
 * case sections are ever fed in pre-split.
 */
function defaultControls(): FxControl[] {
  return [0, 1].map((i) => ({
    key: PARAM_KEYS[i]!,
    kind: PARAM_KINDS[i]!,
    label: PARAM_DEFAULT_LABELS[i]!,
    min: PARAM_RANGES[i]![0],
    max: PARAM_RANGES[i]![1],
  }));
}

/** Default colours section when the section is entirely absent. */
function defaultColors(): FxColorSlot[] {
  return [0, 1, 2].map((i) => ({ index: i as 0 | 1 | 2, label: COLOR_DEFAULT_LABELS[i]! }));
}

// --- Section parsers -------------------------------------------------------

function parseParams(section: string | undefined): FxControl[] {
  if (section === undefined) return defaultControls();
  const labels = section.split(',');
  const out: FxControl[] = [];
  for (let i = 0; i < PARAM_KEYS.length; i++) {
    const rawLabel = labels[i];
    if (rawLabel === undefined) break; // no more positions specified → hidden
    const trimmed = rawLabel.trim();
    if (trimmed === '') continue; // empty label → control hidden
    out.push({
      key: PARAM_KEYS[i]!,
      kind: PARAM_KINDS[i]!,
      label: trimmed === '!' ? PARAM_DEFAULT_LABELS[i]! : trimmed,
      min: PARAM_RANGES[i]![0],
      max: PARAM_RANGES[i]![1],
    });
  }
  return out;
}

function parseColors(section: string | undefined): FxColorSlot[] {
  if (section === undefined) return defaultColors();
  const labels = section.split(',');
  const out: FxColorSlot[] = [];
  for (let i = 0; i < 3; i++) {
    const rawLabel = labels[i];
    if (rawLabel === undefined) break;
    const trimmed = rawLabel.trim();
    if (trimmed === '') continue; // hidden slot — index still advances
    out.push({
      index: i as 0 | 1 | 2,
      label: trimmed === '!' ? COLOR_DEFAULT_LABELS[i]! : trimmed,
    });
  }
  return out;
}

function parsePalette(section: string | undefined): boolean {
  if (section === undefined) return true; // absent → enabled
  if (section.trim() === '') return false; // present but empty → disabled
  return true; // "!" or a restricted list → enabled
}

function parseFlags(section: string | undefined): FxFlags {
  const s = section === undefined || section.trim() === '' ? '1' : section.trim();
  const has = (c: string) => s.includes(c);
  return {
    oneD: has('1'),
    twoD: has('2'),
    threeD: has('3'),
    volumeReactive: has('v'),
    frequencyReactive: has('f'),
    singleLed: has('0'),
  };
}

function parseDefaults(section: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!section) return out;
  // WLED separates defaults with commas. Tolerate a stray ";" too (only reachable
  // via a malformed string with >4 sections, which splitSections glues back on).
  for (const pair of section.split(/[;,]/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = Number(pair.slice(eq + 1).trim());
    if (key && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

// --- Public API ----------------------------------------------------------

export interface ParseFxMetaOptions {
  /** Effect name, used to flag reserved slots and for display. */
  name?: string;
}

/** Parse a single `/json/fxdata` entry. */
export function parseFxMeta(id: number, raw: string, opts: ParseFxMetaOptions = {}): FxMeta {
  const text = raw ?? '';
  // Only split into at most 5 sections; a stray ";" inside defaults is unlikely
  // but this keeps trailing content attached to the defaults section.
  const parts = splitSections(text, 5);
  const name = opts.name;
  return {
    id,
    raw: text,
    ...(name !== undefined ? { name } : {}),
    controls: parseParams(parts[0]),
    colors: parseColors(parts[1]),
    paletteEnabled: parsePalette(parts[2]),
    flags: parseFlags(parts[3]),
    defaults: parseDefaults(parts[4]),
    reserved: name !== undefined && RESERVED_NAMES.has(name),
  };
}

/**
 * Split into at most `max` sections on ";". Preserves the "absent vs empty"
 * distinction: a section is `undefined` only when there was no semicolon for it.
 */
function splitSections(text: string, max: number): (string | undefined)[] {
  const raw = text.split(';');
  const out: (string | undefined)[] = [];
  for (let i = 0; i < max; i++) {
    out.push(i < raw.length ? raw[i] : undefined);
  }
  // If there were more than `max` semicolons, glue the remainder back onto the
  // last section so nothing is silently dropped.
  if (raw.length > max) {
    out[max - 1] = raw.slice(max - 1).join(';');
  }
  return out;
}

export interface ParseFxDataResult {
  effects: FxMeta[];
  /** Non-fatal issues worth surfacing in the UI / logs. */
  warnings: string[];
}

/**
 * Parse the full `/json/fxdata` array against `/json/eff` names.
 *
 * `reserved` effects keep their id (ids are positional) but are flagged so the
 * UI can filter them from pickers without reindexing.
 */
export function parseFxData(
  fxdata: readonly string[],
  effectNames?: readonly string[],
  expectedCount?: number,
): ParseFxDataResult {
  const warnings: string[] = [];

  if (effectNames && effectNames.length !== fxdata.length) {
    warnings.push(
      `/json/eff has ${effectNames.length} entries but /json/fxdata has ${fxdata.length}; ` +
        `pairing by index may be off.`,
    );
  }
  if (expectedCount !== undefined && expectedCount !== fxdata.length) {
    warnings.push(
      `info.fxcount is ${expectedCount} but /json/fxdata has ${fxdata.length} entries.`,
    );
  }

  const effects = fxdata.map((raw, id) => {
    const name = effectNames?.[id];
    return parseFxMeta(id, raw, name !== undefined ? { name } : {});
  });

  return { effects, warnings };
}

/** Effects safe to show in a picker: reserved slots removed, ids preserved. */
export function selectableEffects(effects: readonly FxMeta[]): FxMeta[] {
  return effects.filter((e) => !e.reserved);
}
