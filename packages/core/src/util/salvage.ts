/**
 * Recover the complete leading elements of a truncated JSON array-of-strings.
 *
 * WLED's `/json/fxdata` (and `/json/eff`, `/json/pal`) are served chunked and,
 * on memory-constrained / busy ESP32 devices, are frequently cut off mid-array
 * — verified against real QuinLED/WLED 16.0.x hardware where a full 220-entry
 * fxdata response came back complete only ~1 in 8 requests.
 *
 * Rather than discard a truncated body we salvage every element that arrived
 * intact. The caller pads the remainder (see `padFxData`) so effect ids stay
 * positional and the UI degrades to generic controls for the missing tail.
 */
export interface SalvageResult {
  values: string[];
  /** True when the input was a complete, well-formed JSON string array. */
  complete: boolean;
}

export function salvageJsonStringArray(raw: string): SalvageResult {
  const text = raw.trimStart();
  if (text[0] !== '[') return { values: [], complete: false };

  const values: string[] = [];
  let i = 1;
  const n = text.length;

  // Skip whitespace helper.
  const ws = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  };

  ws();
  if (text[i] === ']') return { values: [], complete: true };

  while (i < n) {
    ws();
    if (text[i] !== '"') break; // expected a string element; give up on the rest

    // Read one JSON string.
    let j = i + 1;
    let out = '';
    let closed = false;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\') {
        if (j + 1 >= n) break; // truncated inside an escape
        const esc = text[j + 1];
        switch (esc) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case '/': out += '/'; break;
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          case 'u': {
            if (j + 6 > n) { j = n; break; }
            out += String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16));
            j += 4;
            break;
          }
          default: out += esc;
        }
        j += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        j++;
        break;
      }
      out += ch;
      j++;
    }

    if (!closed) break; // string ran off the end of the buffer — stop here

    // Element complete.
    values.push(out);
    i = j;
    ws();

    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === ']') {
      return { values, complete: true };
    }
    // Anything else (or end of buffer) means the array was cut after this element.
    break;
  }

  return { values, complete: false };
}

/**
 * Pad (or trim) a salvaged fxdata array to exactly `count` entries. Padding
 * entries are `""`, which the fxdata parser reads as "no params" → the UI shows
 * generic Speed/Intensity sliders and all three colour slots.
 */
export function padStringArray(values: readonly string[], count: number): string[] {
  if (values.length === count) return [...values];
  if (values.length > count) return values.slice(0, count);
  return [...values, ...Array<string>(count - values.length).fill('')];
}
