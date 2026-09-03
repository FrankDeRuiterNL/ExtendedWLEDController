import { Box, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import type { FxControl, FxMeta, WledColor, WledSegment } from '@ewc/core';
import { CommittedSlider } from './CommittedSlider.js';
import { md3 } from '../theme/tokens.js';

// --- helpers ---------------------------------------------------------------

function toHex(c: WledColor | undefined): string {
  if (!c) return '#000000';
  if (typeof c === 'string') return `#${c.replace(/^#/, '').slice(0, 6).padStart(6, '0')}`;
  const [r, g, b] = c;
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0')).join('')}`;
}

function fromHex(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const controlValue = (seg: WledSegment, key: FxControl['key']): number => {
  const v = seg[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return key === 'sx' || key === 'ix' ? 128 : 0;
};

// --- effect + palette pickers -------------------------------------------

export function EffectPicker({
  effects,
  palettes,
  segment,
  selectedMeta,
  onEffect,
  onPalette,
}: {
  effects: FxMeta[];
  palettes: string[];
  segment: WledSegment;
  selectedMeta: FxMeta | undefined;
  onEffect: (fx: number) => void;
  onPalette: (pal: number) => void;
}) {
  const currentFx = typeof segment.fx === 'number' ? segment.fx : 0;
  const currentPal = typeof segment.pal === 'number' ? segment.pal : 0;
  const paletteEnabled = selectedMeta?.paletteEnabled ?? true;

  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
      <TextField
        select
        label="Effect"
        value={currentFx}
        onChange={(e) => onEffect(Number(e.target.value))}
        fullWidth
      >
        {effects
          .filter((e) => !e.reserved)
          .map((e) => (
            <MenuItem key={e.id} value={e.id}>
              {e.name ?? `Effect ${e.id}`}
              {e.flags.twoD && !e.flags.oneD ? ' · 2D' : ''}
              {e.flags.volumeReactive || e.flags.frequencyReactive ? ' · audio' : ''}
            </MenuItem>
          ))}
      </TextField>

      <TextField
        select
        label="Palette"
        value={currentPal}
        onChange={(e) => onPalette(Number(e.target.value))}
        fullWidth
        disabled={!paletteEnabled}
        helperText={!paletteEnabled ? 'This effect does not use a palette' : undefined}
      >
        {palettes.map((p, i) => (
          <MenuItem key={i} value={i}>
            {p}
          </MenuItem>
        ))}
      </TextField>
    </Stack>
  );
}

// --- dynamic sliders / checkboxes --------------------------------------

export function EffectControls({
  meta,
  segment,
  onChange,
}: {
  meta: FxMeta;
  segment: WledSegment;
  onChange: (patch: Partial<WledSegment>) => void;
}) {
  const sliders = meta.controls.filter((c) => c.kind === 'slider');
  const switches = meta.controls.filter((c) => c.kind === 'checkbox');

  if (meta.controls.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        This effect has no adjustable parameters.
      </Typography>
    );
  }

  return (
    <Stack spacing={2.5}>
      {sliders.map((c) => (
        <ControlSlider key={c.key} control={c} value={controlValue(segment, c.key)} onCommit={(v) => onChange({ [c.key]: v })} />
      ))}
      {switches.length > 0 && (
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {switches.map((c) => (
            <FormControlLabel
              key={c.key}
              control={
                <Switch
                  checked={controlValue(segment, c.key) > 0}
                  onChange={(e) => onChange({ [c.key]: e.target.checked })}
                />
              }
              label={c.label}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function ControlSlider({
  control,
  value,
  onCommit,
}: {
  control: FxControl;
  value: number;
  onCommit: (v: number) => void;
}) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="subtitle2">{control.label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {value}
        </Typography>
      </Stack>
      <CommittedSlider
        size="small"
        min={control.min}
        max={control.max}
        value={value}
        onCommit={onCommit}
      />
    </Box>
  );
}

// --- colour slots -----------------------------------------------------

export function ColorSlots({
  meta,
  segment,
  hasWhite,
  onChange,
}: {
  meta: FxMeta;
  segment: WledSegment;
  hasWhite: boolean;
  onChange: (patch: Partial<WledSegment>) => void;
}) {
  if (meta.colors.length === 0) return null;
  const cols = segment.col ?? [];

  const setColor = (slot: number, rgb: [number, number, number]) => {
    const next: WledColor[] = [0, 1, 2].map((i) => {
      if (i === slot) return hasWhite ? [...rgb, whiteOf(cols[i])] : rgb;
      const existing = cols[i];
      return existing ?? [0, 0, 0];
    });
    onChange({ col: next });
  };

  const setWhite = (slot: number, w: number) => {
    const [r, g, b] = rgbOf(cols[slot]);
    const next: WledColor[] = [0, 1, 2].map((i) => (i === slot ? [r, g, b, w] : cols[i] ?? [0, 0, 0]));
    onChange({ col: next });
  };

  return (
    <Stack spacing={2}>
      {meta.colors.map((c) => (
        <Stack key={c.index} direction="row" spacing={2} alignItems="center">
          <Box
            component="label"
            sx={{
              width: 44,
              height: 44,
              borderRadius: 2,
              border: `1px solid ${md3.outline}`,
              overflow: 'hidden',
              cursor: 'pointer',
              flexShrink: 0,
              bgcolor: toHex(cols[c.index]),
            }}
          >
            <input
              type="color"
              value={toHex(cols[c.index])}
              onChange={(e) => setColor(c.index, fromHex(e.target.value))}
              style={{ opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
            />
          </Box>
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle2">{c.label}</Typography>
            {hasWhite && (
              <CommittedSlider
                size="small"
                min={0}
                max={255}
                value={whiteOf(cols[c.index])}
                onCommit={(v) => setWhite(c.index, v)}
                sx={{ mt: 0.5 }}
                aria-label={`${c.label} white channel`}
              />
            )}
          </Box>
        </Stack>
      ))}
    </Stack>
  );
}

function rgbOf(c: WledColor | undefined): [number, number, number] {
  if (!c) return [0, 0, 0];
  if (typeof c === 'string') return fromHex(toHex(c));
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}
function whiteOf(c: WledColor | undefined): number {
  return Array.isArray(c) && typeof c[3] === 'number' ? c[3] : 0;
}
