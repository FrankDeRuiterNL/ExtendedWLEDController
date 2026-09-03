import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { padStringArray, salvageJsonStringArray } from './salvage.js';

const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/${path}`, import.meta.url)), 'utf8');

describe('salvageJsonStringArray', () => {
  it('returns complete=true for a well-formed array', () => {
    expect(salvageJsonStringArray('["a","b","c"]')).toEqual({ values: ['a', 'b', 'c'], complete: true });
  });

  it('handles an empty array', () => {
    expect(salvageJsonStringArray('[]')).toEqual({ values: [], complete: true });
  });

  it('recovers whole elements from an array cut after a comma', () => {
    expect(salvageJsonStringArray('["a","b",')).toEqual({ values: ['a', 'b'], complete: false });
  });

  it('recovers whole elements from an array cut mid-string', () => {
    expect(salvageJsonStringArray('["a","bcdef')).toEqual({ values: ['a'], complete: false });
  });

  it('drops a partial element with a dangling escape', () => {
    expect(salvageJsonStringArray('["a","b\\')).toEqual({ values: ['a'], complete: false });
  });

  it('unescapes within elements', () => {
    expect(salvageJsonStringArray('["a\\"b","c\\\\d"]').values).toEqual(['a"b', 'c\\d']);
  });

  it('preserves the semicolons/commas inside fxdata entries', () => {
    const raw = '["!,Duty cycle;!,!;!;01","!;!,!;!;01",';
    expect(salvageJsonStringArray(raw)).toEqual({
      values: ['!,Duty cycle;!,!;!;01', '!;!,!;!;01'],
      complete: false,
    });
  });

  it('rejects non-array input', () => {
    expect(salvageJsonStringArray('{"a":1}')).toEqual({ values: [], complete: false });
    expect(salvageJsonStringArray('')).toEqual({ values: [], complete: false });
  });

  it('salvages a REAL truncated /json/fxdata response from WLED 16.0.1 hardware', () => {
    const raw = fixture('wled-16.0.1-quinled/fxdata-raw-truncated.txt');
    // A longer (but still truncated) capture of the SAME build, for reference.
    const reference: string[] = JSON.parse(fixture('wled-16.0.1-quinled/fxdata-partial-192.json'));

    // The captured body is 5501 bytes and does NOT parse as JSON…
    expect(() => JSON.parse(raw)).toThrow();

    const { values, complete: ok } = salvageJsonStringArray(raw);
    expect(ok).toBe(false);
    expect(values.length).toBeGreaterThan(120);
    expect(values.length).toBeLessThan(reference.length);
    // …but every element we recovered matches the reference capture exactly,
    // semicolons and commas intact.
    values.forEach((v, i) => expect(v).toBe(reference[i]));
    expect(values).toContain('!,!;1,2,3;!;;sx=24,pal=50'); // Aurora survived
  });
});

describe('padStringArray', () => {
  it('pads short arrays with empty strings', () => {
    expect(padStringArray(['a', 'b'], 4)).toEqual(['a', 'b', '', '']);
  });
  it('trims long arrays', () => {
    expect(padStringArray(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
  it('returns a copy at the exact length', () => {
    const input = ['a', 'b'];
    const out = padStringArray(input, 2);
    expect(out).toEqual(['a', 'b']);
    expect(out).not.toBe(input);
  });
});
