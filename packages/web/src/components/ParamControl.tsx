import { Box, MenuItem, Slider, Stack, Switch, TextField, Typography } from '@mui/material';
import type { ParamDef, ParamValue } from '@ewc/core';
import { md3 } from '../theme/tokens.js';

export function rgbToHex(c: readonly number[]): string {
  return (
    '#' +
    [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
      .join('')
  );
}
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

export function ParamControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: ParamValue | undefined;
  onChange: (v: ParamValue) => void;
}) {
  if (def.type === 'bool') {
    return (
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="body2">{def.label}</Typography>
        <Switch
          size="small"
          checked={typeof value === 'boolean' ? value : def.default === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      </Stack>
    );
  }

  if (def.type === 'select') {
    return (
      <TextField
        select
        size="small"
        fullWidth
        label={def.label}
        value={typeof value === 'string' ? value : String(def.default)}
        onChange={(e) => onChange(e.target.value)}
      >
        {(def.options ?? []).map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label}
          </MenuItem>
        ))}
      </TextField>
    );
  }

  if (def.type === 'color') {
    const arr = Array.isArray(value) ? value : (def.default as number[]);
    return (
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
        <Typography variant="body2">{def.label}</Typography>
        <Box
          component="label"
          sx={{
            width: 40,
            height: 28,
            borderRadius: 1,
            border: `1px solid ${md3.outline}`,
            overflow: 'hidden',
            cursor: 'pointer',
            bgcolor: rgbToHex(arr),
          }}
        >
          <input
            type="color"
            value={rgbToHex(arr)}
            onChange={(e) => onChange(hexToRgb(e.target.value))}
            style={{ opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
          />
        </Box>
      </Stack>
    );
  }

  // number
  const num = typeof value === 'number' ? value : (def.default as number);
  const min = def.min ?? 0;
  const max = def.max ?? 1;
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="body2">{def.label}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {Number.isInteger(num) ? num : num.toFixed(2)}
        </Typography>
      </Stack>
      <Slider
        size="small"
        min={min}
        max={max}
        step={def.step ?? (max - min) / 100}
        value={num}
        onChange={(_, v) => onChange(v as number)}
      />
      {def.hint && (
        <Typography variant="caption" color="text.secondary">
          {def.hint}
        </Typography>
      )}
    </Box>
  );
}
