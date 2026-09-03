import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  LinearProgress,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import {
  LED_TYPES,
  dataLineLoad,
  estimatePower,
  fixtureLedCount,
  ledTypeById,
  mapFixture,
  type Installation,
  type OutputHardware,
} from '@ewc/core';
import { floorplanUrl, useInstallation, useSaveInstallation } from '../api/stage.js';
import { useDevices } from '../api/devices.js';
import { md3 } from '../theme/tokens.js';

export function HardwarePage() {
  const { data: saved } = useInstallation();
  const save = useSaveInstallation();
  const { data: devices } = useDevices();

  const [inst, setInst] = useState<Installation | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showFloorplan, setShowFloorplan] = useState(() => {
    try {
      return localStorage.getItem('ewc.hardware.showFloorplan') !== '0';
    } catch {
      return true;
    }
  });
  const toggleFloorplan = (on: boolean) => {
    setShowFloorplan(on);
    try {
      localStorage.setItem('ewc.hardware.showFloorplan', on ? '1' : '0');
    } catch {
      /* private mode — no persistence */
    }
  };

  useEffect(() => {
    if (saved && !dirty) setInst(saved);
  }, [saved, dirty]);

  if (!inst) return null;

  const selected = inst.fixtures.find((f) => f.id === selectedId) ?? null;
  const deviceId = selected?.deviceId ?? null;
  const device = devices?.find((d) => d.id === deviceId) ?? null;

  // A "fixture" is just a named section of one continuous strip on a device
  // output — their LEDs run on in wire order, so power is planned per output.
  const outputFixtures =
    deviceId == null
      ? []
      : inst.fixtures
          .filter((f) => f.deviceId === deviceId)
          .sort((a, b) => a.startIndex - b.startIndex);
  const fixturesLedTotal = outputFixtures.reduce((n, f) => n + fixtureLedCount(f.geometry), 0);
  const outputLedCount = device?.ledCount ?? fixturesLedTotal;

  const cfgKey = deviceId == null ? '' : String(deviceId);
  const cfg: OutputHardware = (cfgKey && inst.outputs?.[cfgKey]) || {};
  const ledType = ledTypeById(cfg.ledTypeId);
  const estimate = ledType
    ? estimatePower({ ledCount: outputLedCount, ledType, ledsPerMeter: cfg.ledsPerMeter ?? null })
    : null;
  const dataLine = dataLineLoad(outputLedCount);

  const patchOutput = (patch: Partial<OutputHardware>) => {
    if (deviceId == null) return;
    const key = String(deviceId);
    const merged = { ...(inst.outputs?.[key] ?? {}), ...patch };
    const cleaned: OutputHardware = {};
    if (merged.ledTypeId) cleaned.ledTypeId = merged.ledTypeId;
    if (merged.ledsPerMeter && merged.ledsPerMeter > 0) cleaned.ledsPerMeter = merged.ledsPerMeter;
    setInst({ ...inst, outputs: { ...(inst.outputs ?? {}), [key]: cleaned } });
    setDirty(true);
  };

  // Where each injection point physically lands on the plot.
  const injectionMarkers = (estimate?.injectionPoints ?? []).map((pt, i) => {
    const host = outputFixtures.find(
      (f) => pt.atLed >= f.startIndex && pt.atLed < f.startIndex + fixtureLedCount(f.geometry),
    );
    if (!host) return { ...pt, n: i + 1, x: null as number | null, y: null as number | null };
    const leds = mapFixture(host, inst.canvas);
    const led = leds[Math.min(pt.atLed - host.startIndex, leds.length - 1)];
    return {
      ...pt,
      n: i + 1,
      x: led ? led.x * inst.canvas.width : null,
      y: led ? led.y * inst.canvas.height : null,
    };
  });

  const vb = `0 0 ${inst.canvas.width} ${inst.canvas.height}`;
  const markerR = Math.max(0.22, Math.min(inst.canvas.width, inst.canvas.height) * 0.009);

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h2">Hardware</Typography>
          <Typography variant="body2" color="text.secondary">
            Plan power and data for each output. Pick a fixture to set its LED type and see the
            supply and injection points it needs. Positions are set on the Layout page.
          </Typography>
        </Box>
        <Button
          startIcon={<SaveIcon />}
          variant="contained"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(inst, { onSuccess: () => setDirty(false) })}
        >
          {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </Button>
      </Stack>

      {inst.fixtures.length === 0 && (
        <Alert severity="info">No fixtures yet — add them on the Layout page first.</Alert>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 340px' } }}>
        <Card>
          <CardContent sx={{ p: 1 }}>
            <Box
              component="svg"
              viewBox={vb}
              onPointerDown={(e: React.PointerEvent) => {
                if (e.button === 0) setSelectedId(null);
              }}
              sx={{
                width: '100%',
                aspectRatio: `${inst.canvas.width} / ${inst.canvas.height}`,
                bgcolor: md3.surfaceContainerLowest,
                borderRadius: 2,
                touchAction: 'none',
              }}
            >
              <defs>
                <pattern id="hw-grid" width="1" height="1" patternUnits="userSpaceOnUse">
                  <path d="M1 0 L0 0 0 1" fill="none" stroke={md3.outlineVariant} strokeWidth="0.02" />
                </pattern>
              </defs>

              {showFloorplan && inst.floorplan && (
                <image
                  href={floorplanUrl(inst.floorplan)}
                  x={inst.floorplan.position.x - inst.floorplan.size.x / 2}
                  y={inst.floorplan.position.y - inst.floorplan.size.y / 2}
                  width={inst.floorplan.size.x}
                  height={inst.floorplan.size.y}
                  opacity={0.4}
                  preserveAspectRatio="none"
                />
              )}

              <rect
                x={0}
                y={0}
                width={inst.canvas.width}
                height={inst.canvas.height}
                fill="url(#hw-grid)"
                pointerEvents="none"
              />

              {inst.fixtures.map((f) => {
                const leds = mapFixture(f, inst.canvas);
                const isSel = f.id === selectedId;
                const onOutput = deviceId != null && f.deviceId === deviceId;
                const xs = leds.map((l) => l.x * inst.canvas.width);
                const ys = leds.map((l) => l.y * inst.canvas.height);
                const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : f.transform.position.x;
                const labelY = (ys.length ? Math.max(...ys) : f.transform.position.y) + 0.42;
                const accent = isSel ? md3.primary : onOutput ? `${md3.primary}99` : md3.outline;
                return (
                  <g
                    key={f.id}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedId(f.id);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <g transform={`translate(${f.transform.position.x} ${f.transform.position.y}) rotate(${f.transform.rotationDeg})`}>
                      <rect
                        x={-f.transform.size.x / 2}
                        y={-f.transform.size.y / 2}
                        width={f.transform.size.x}
                        height={f.transform.size.y}
                        rx={0.15}
                        fill={isSel ? `${md3.primary}2E` : onOutput ? `${md3.primary}14` : `${md3.onSurfaceVariant}0F`}
                        stroke={accent}
                        strokeWidth={isSel ? 0.07 : onOutput ? 0.04 : 0.03}
                      />
                    </g>
                    {leds.map((l, i) => (
                      <circle
                        key={i}
                        cx={l.x * inst.canvas.width}
                        cy={l.y * inst.canvas.height}
                        r={0.06}
                        fill={i === 0 ? md3.primary : md3.onSurface}
                        opacity={onOutput || deviceId == null ? 0.85 : 0.4}
                      />
                    ))}
                    <text
                      x={cx}
                      y={labelY}
                      textAnchor="middle"
                      dominantBaseline="hanging"
                      fontSize={0.4}
                      fontWeight={600}
                      fill={isSel ? md3.primary : md3.onSurface}
                      opacity={onOutput || deviceId == null ? 0.85 : 0.4}
                      style={{ paintOrder: 'stroke', stroke: md3.surfaceContainerLowest, strokeWidth: 0.12 }}
                    >
                      {f.name}
                    </text>
                  </g>
                );
              })}

              {injectionMarkers.map((m) =>
                m.x == null || m.y == null ? null : (
                  <g key={m.n} pointerEvents="none">
                    <circle
                      cx={m.x}
                      cy={m.y}
                      r={markerR * 1.9}
                      fill="none"
                      stroke={md3.primary}
                      strokeWidth={markerR * 0.28}
                      opacity={0.45}
                    />
                    <circle
                      cx={m.x}
                      cy={m.y}
                      r={markerR}
                      fill={md3.primary}
                      stroke={md3.surfaceContainerLowest}
                      strokeWidth={markerR * 0.28}
                    />
                    <text
                      x={m.x + markerR * 2.2}
                      y={m.y}
                      dominantBaseline="central"
                      fontSize={markerR * 1.4}
                      fontWeight={700}
                      fill={md3.primary}
                      style={{ paintOrder: 'stroke', stroke: md3.surfaceContainerLowest, strokeWidth: markerR * 0.9 }}
                    >
                      +{m.n} · {m.meters} m
                    </text>
                  </g>
                ),
              )}
            </Box>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1, pt: 0.5 }}>
              <Switch
                size="small"
                checked={showFloorplan && !!inst.floorplan}
                disabled={!inst.floorplan}
                onChange={(e) => toggleFloorplan(e.target.checked)}
              />
              <Typography variant="body2" color="text.secondary">
                Show floorplan
              </Typography>
            </Stack>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            {!selected ? (
              <Typography variant="body2" color="text.secondary">
                {inst.fixtures.length === 0
                  ? 'Add fixtures on the Layout page, then plan their power here.'
                  : 'Select a fixture in the plot to plan its power and data.'}
              </Typography>
            ) : (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h6">{selected.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {fixtureLedCount(selected.geometry)} LEDs · wire {selected.startIndex}–
                    {selected.startIndex + fixtureLedCount(selected.geometry) - 1} of {outputLedCount}
                  </Typography>
                </Box>

                <Divider textAlign="left">
                  <Typography variant="overline" color="text.secondary">
                    Output — {device?.name ?? `device #${deviceId}`}
                  </Typography>
                </Divider>

                <Stat label="LEDs on this output" value={String(outputLedCount)} />

                <Box>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                    <Typography variant="body2" color="text.secondary">
                      Data line
                    </Typography>
                    <Typography variant="body2" fontWeight={600} color={dataLine.over ? 'error.main' : 'text.primary'}>
                      {dataLine.percent}%
                    </Typography>
                  </Stack>
                  <LinearProgress
                    variant="determinate"
                    value={Math.min(100, dataLine.percent)}
                    color={dataLine.over ? 'error' : dataLine.fraction > 0.8 ? 'warning' : 'primary'}
                    sx={{
                      mt: 0.5,
                      height: 6,
                      borderRadius: 3,
                      bgcolor: md3.surfaceContainerHighest,
                    }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {dataLine.ledCount} / {dataLine.budget} LEDs — the practical limit for one data
                    output at a usable frame rate.
                    {dataLine.over && ' Split this run across another output.'}
                  </Typography>
                </Box>

                <TextField
                  select
                  size="small"
                  label="LED type"
                  value={cfg.ledTypeId ?? ''}
                  onChange={(e) => patchOutput({ ledTypeId: e.target.value || undefined })}
                >
                  <MenuItem value="">
                    <em>Not set</em>
                  </MenuItem>
                  {LED_TYPES.map((t) => (
                    <MenuItem key={t.id} value={t.id}>
                      {t.name}
                    </MenuItem>
                  ))}
                </TextField>

                {!ledType ? (
                  <Typography variant="caption" color="text.secondary">
                    Choose the LED type to calculate power draw and injection points.
                  </Typography>
                ) : (
                  <>
                    <TextField
                      type="number"
                      size="small"
                      label="LEDs per metre"
                      value={cfg.ledsPerMeter ?? ''}
                      placeholder={String(ledType.typicalLedsPerMeter)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        patchOutput({ ledsPerMeter: v > 0 ? v : undefined });
                      }}
                      helperText={
                        cfg.ledsPerMeter
                          ? `≈ ${estimate?.lengthMeters} m of strip`
                          : `Assuming ${ledType.typicalLedsPerMeter}/m · ≈ ${estimate?.lengthMeters} m`
                      }
                    />

                    <Stat
                      label="Max power"
                      value={`${estimate!.maxAmps} A`}
                      sub={`at ${estimate!.voltage} V · ${estimate!.maxWatts} W, all LEDs full white`}
                    />

                    <Stat
                      label="Power supply at the strip start"
                      value={`${estimate!.psu.voltage} V · ${estimate!.psu.amps} A`}
                      sub={`${estimate!.psu.watts} W — worst case plus 25% headroom`}
                    />

                    <Box>
                      <Typography variant="body2" color="text.secondary">
                        Power injection
                      </Typography>
                      {estimate!.injectionPoints.length === 0 ? (
                        <Typography variant="body2" sx={{ mt: 0.5 }}>
                          None needed — one feed at the start covers the whole {estimate!.lengthMeters}{' '}
                          m run.
                        </Typography>
                      ) : (
                        <>
                          <Typography variant="body2" fontWeight={600} sx={{ mt: 0.5 }}>
                            {estimate!.injectionPoints.length} extra{' '}
                            {estimate!.injectionPoints.length === 1 ? 'point' : 'points'}
                          </Typography>
                          <Stack component="ul" sx={{ pl: 2, m: 0, mt: 0.5 }} spacing={0.25}>
                            {estimate!.injectionPoints.map((p, i) => (
                              <li key={p.atLed}>
                                <Typography variant="caption" color="text.secondary">
                                  <strong>+{i + 1}</strong> after LED {p.atLed} · ≈ {p.meters} m from
                                  the start
                                </Typography>
                              </li>
                            ))}
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            Feed {estimate!.voltage} V in at each <strong>+</strong> marker on the plot.
                          </Typography>
                        </>
                      )}
                    </Box>
                  </>
                )}
              </Stack>
            )}
          </CardContent>
        </Card>
      </Box>
    </Stack>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" sx={{ lineHeight: 1.2 }}>
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary">
          {sub}
        </Typography>
      )}
    </Box>
  );
}
