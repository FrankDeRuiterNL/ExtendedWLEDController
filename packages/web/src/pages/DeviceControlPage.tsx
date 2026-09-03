import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LanIcon from '@mui/icons-material/Lan';
import { useNavigate, useParams } from 'react-router-dom';
import {
  brightnessPatch,
  cctIsKelvin,
  decodeCapabilities,
  kelvinToRgbGain,
  CCT_KELVIN_MAX,
  CCT_KELVIN_MIN,
  WHITE_BALANCE_MAX_K,
  WHITE_BALANCE_MIN_K,
  WHITE_BALANCE_NEUTRAL_K,
  type LinkType,
  type WledSegment,
  type WledState,
} from '@ewc/core';
import {
  useControlDevice,
  useDeleteDevice,
  useDevice,
  useRefreshDevice,
  useRefreshFxData,
  useUpdateDevice,
} from '../api/devices.js';
import { useSetStreamConfig, useStreamStatus } from '../api/stage.js';
import { ColorSlots, EffectControls, EffectPicker } from '../components/EffectControls.js';
import { CommittedSlider } from '../components/CommittedSlider.js';
import { NodeImportDialog } from '../components/NodeImportDialog.js';
import { StatusDot } from '../components/StatusDot.js';
import { md3 } from '../theme/tokens.js';

export function DeviceControlPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const { data: device, isLoading, isError } = useDevice(id);
  const control = useControlDevice(id);
  const refresh = useRefreshDevice(id);
  const refreshFx = useRefreshFxData(id);
  const update = useUpdateDevice(id);
  const del = useDeleteDevice();

  const state: WledState = device?.state ?? {};
  const segments = state.seg?.filter((s) => (s.stop ?? 0) > (s.start ?? 0) || s.id === state.mainseg) ?? [];
  const [segId, setSegId] = useState<number | null>(null);
  const [nodeImportOpen, setNodeImportOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const activeSegId = segId ?? state.mainseg ?? segments[0]?.id ?? 0;
  const segment: WledSegment = segments.find((s) => s.id === activeSegId) ?? { id: activeSegId };

  const effects = device?.effects ?? [];
  const selectedMeta = useMemo(
    () => effects.find((e) => e.id === (typeof segment.fx === 'number' ? segment.fx : 0)),
    [effects, segment.fx],
  );

  const segCaps = decodeCapabilities(device?.seglc?.[activeSegId] ?? device?.capabilities.raw ?? 1);

  const send = (patch: WledState) => control.mutate(patch);
  const sendSeg = (fields: Partial<WledSegment>) => send({ seg: [{ id: activeSegId, ...fields }] });

  const selectEffect = (fx: number) => {
    // The device does NOT apply /json/fxdata `defaults` itself (verified: fxdef
    // is a no-op on this firmware), so apply them from the parsed metadata.
    const defaults = effects.find((e) => e.id === fx)?.defaults ?? {};
    sendSeg({ fx, ...(defaults as Partial<WledSegment>) });
  };

  if (isLoading) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (isError || !device) {
    return (
      <Stack spacing={2}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/devices')} sx={{ alignSelf: 'flex-start' }}>
          Devices
        </Button>
        <Alert severity="error">Device not found.</Alert>
      </Stack>
    );
  }

  const briValue = state.on === false ? 0 : (state.bri ?? 0);

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <IconButton onClick={() => navigate('/devices')} aria-label="Back to devices">
          <ArrowBackIcon />
        </IconButton>
        <StatusDot connection={device.connection} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h3" noWrap>
            {device.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {device.host}
            {device.port !== 80 ? `:${device.port}` : ''} · {device.arch ?? '—'} · fw {device.fwVersion ?? '—'} ·{' '}
            {device.ledCount ?? '—'} LEDs · {device.health?.fps ?? '—'} fps
          </Typography>
        </Box>
        <Tooltip title="Re-read info / effects / palettes / cfg">
          <span>
            <IconButton onClick={() => refresh.mutate()} disabled={refresh.isPending} aria-label="Refresh">
              <RefreshIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {device.warnings.length > 0 && (
        <Stack spacing={1}>
          {device.warnings.map((w, i) => (
            <Alert
              key={i}
              severity={w.severity === 'warning' ? 'warning' : 'info'}
              variant="outlined"
              action={
                w.code === 'fxdata-missing' ? (
                  <Button
                    color="inherit"
                    size="small"
                    disabled={refreshFx.isPending}
                    onClick={() => refreshFx.mutate()}
                  >
                    {refreshFx.isPending ? 'Retrying…' : 'Retry'}
                  </Button>
                ) : undefined
              }
            >
              {w.message}
            </Alert>
          ))}
        </Stack>
      )}

      {control.isError && (
        <Alert severity="error" onClose={() => control.reset()}>
          {(control.error as Error)?.message ?? 'The device rejected that change.'}
        </Alert>
      )}

      {/* --- Power & brightness --- */}
      <Card>
        <CardContent>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="h4">Master</Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={state.on !== false}
                  onChange={(e) => send({ on: e.target.checked })}
                />
              }
              label={state.on !== false ? 'On' : 'Off'}
            />
          </Stack>
          <Typography variant="subtitle2" gutterBottom>
            Brightness {briValue > 0 ? `· ${briValue}` : '· off'}
          </Typography>
          <CommittedSlider
            min={0}
            max={255}
            value={briValue}
            onCommit={(v) => send(brightnessPatch(v))}
          />
          <Divider sx={{ my: 2 }} />
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="subtitle2">Crossfade</Typography>
            <CommittedSlider
              min={0}
              max={20}
              value={state.transition ?? 7}
              valueLabelDisplay="auto"
              formatValue={(v) => `${(v / 10).toFixed(1)}s`}
              onCommit={(v) => send({ transition: v })}
              sx={{ maxWidth: 260 }}
            />
          </Stack>
        </CardContent>
      </Card>

      {/* --- Segment control --- */}
      <Card>
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }} flexWrap="wrap">
            <Typography variant="h4">Segment</Typography>
            {segments.length > 1 ? (
              <TextField
                select
                size="small"
                value={activeSegId}
                onChange={(e) => setSegId(Number(e.target.value))}
                sx={{ minWidth: 160 }}
              >
                {segments.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.n || `Segment ${s.id}`} ({s.start ?? 0}–{s.stop ?? 0})
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Chip
                size="small"
                variant="outlined"
                label={`${segment.n || `Segment ${activeSegId}`} · ${segment.start ?? 0}–${segment.stop ?? device.ledCount ?? 0}`}
              />
            )}
            <Box sx={{ flex: 1 }} />
            <Stack direction="row" spacing={0.5}>
              {segCaps.rgb && <Chip size="small" label="RGB" />}
              {segCaps.white && <Chip size="small" label="White" />}
              {segCaps.cct && <Chip size="small" label="CCT" />}
            </Stack>
            <FormControlLabel
              control={
                <Switch checked={segment.on !== false} onChange={(e) => sendSeg({ on: e.target.checked })} />
              }
              label="On"
            />
          </Stack>

          <Stack spacing={3}>
            <EffectPicker
              effects={effects}
              palettes={device.palettes}
              segment={segment}
              selectedMeta={selectedMeta}
              onEffect={selectEffect}
              onPalette={(pal) => sendSeg({ pal })}
            />

            {selectedMeta?.flags.twoD && !selectedMeta.flags.oneD && !device.matrix && (
              <Alert severity="info" variant="outlined">
                “{selectedMeta.name}” needs a 2D matrix. On this 1D strip WLED will fall back to Solid.
              </Alert>
            )}

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Segment brightness
              </Typography>
              <CommittedSlider
                min={0}
                max={255}
                value={segment.bri ?? 255}
                onCommit={(v) => sendSeg({ bri: v })}
              />
            </Box>

            {selectedMeta && (
              <>
                <Divider textAlign="left">
                  <Typography variant="overline" color="text.secondary">
                    {selectedMeta.name} parameters
                  </Typography>
                </Divider>
                <EffectControls meta={selectedMeta} segment={segment} onChange={sendSeg} />
                {selectedMeta.colors.length > 0 && (
                  <>
                    <Divider textAlign="left">
                      <Typography variant="overline" color="text.secondary">
                        Colours
                      </Typography>
                    </Divider>
                    <ColorSlots meta={selectedMeta} segment={segment} hasWhite={segCaps.white} onChange={sendSeg} />
                  </>
                )}
              </>
            )}

            {segCaps.cct && <CctControl segment={segment} onChange={sendSeg} />}
          </Stack>
        </CardContent>
      </Card>

      <WhiteBalanceCard deviceId={device.id} hasWhiteChannel={device.capabilities.white} />

      {/* --- Device settings --- */}
      <Card>
        <CardContent>
          <Typography variant="h4" gutterBottom>
            Device settings
          </Typography>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Display name"
              defaultValue={device.name}
              size="small"
              onBlur={(e) => e.target.value.trim() && e.target.value !== device.name && update.mutate({ name: e.target.value.trim() })}
              sx={{ maxWidth: 320 }}
            />
            <TextField
              select
              label="Connection"
              value={device.linkType}
              size="small"
              onChange={(e) => update.mutate({ linkType: e.target.value as LinkType })}
              sx={{ maxWidth: 320 }}
            >
              <MenuItem value="unknown">Unknown</MenuItem>
              <MenuItem value="wifi">Wi-Fi</MenuItem>
              <MenuItem value="ethernet">Wired Ethernet</MenuItem>
            </TextField>

            {device.linkType === 'ethernet' && (
              <TextField
                select
                label="Ethernet link speed"
                value={device.ethSpeedMbps ?? 100}
                size="small"
                helperText="WLED doesn't report this — set it to match the controller's LAN port."
                onChange={(e) => update.mutate({ ethSpeedMbps: Number(e.target.value) as 10 | 100 | 1000 })}
                sx={{ maxWidth: 320 }}
              >
                <MenuItem value={10}>10 Mbps</MenuItem>
                <MenuItem value={100}>100 Mbps</MenuItem>
                <MenuItem value={1000}>1000 Mbps</MenuItem>
              </TextField>
            )}

            <Box>
              <Typography variant="subtitle2">Brightness / gamma policy</Typography>
              <Typography variant="caption" color="text.secondary">
                Consumed by the realtime sender &amp; renderer in later milestones. Device gamma:{' '}
                {device.deviceGamma
                  ? `bri ${device.deviceGamma.bri}, col ${device.deviceGamma.col}, val ${device.deviceGamma.val}`
                  : 'unknown'}
                {device.realtime.gammaDisabled !== null &&
                  ` · realtime gamma ${device.realtime.gammaDisabled ? 'disabled' : 'enabled'} on device`}
              </Typography>
              <TextField
                select
                label="Mode"
                size="small"
                value={device.brightnessPolicy.mode}
                onChange={(e) =>
                  update.mutate({
                    brightnessPolicy: {
                      ...device.brightnessPolicy,
                      mode: e.target.value as 'passthrough' | 'pin255',
                    },
                  })
                }
                sx={{ mt: 1, maxWidth: 320, display: 'block' }}
              >
                <MenuItem value="passthrough">Passthrough — device applies bri &amp; gamma</MenuItem>
                <MenuItem value="pin255">Pin bri 255 — dim &amp; gamma in software</MenuItem>
              </TextField>
            </Box>

            <Divider />
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              <Button
                variant="outlined"
                startIcon={<LanIcon />}
                onClick={() => setNodeImportOpen(true)}
              >
                Scan for other WLED devices
              </Button>
              <Button
                color="error"
                variant="outlined"
                startIcon={<DeleteOutlineIcon />}
                disabled={del.isPending}
                onClick={() => setConfirmDelete(true)}
              >
                Remove device
              </Button>
            </Stack>

            {del.isError && (
              <Alert severity="error" onClose={() => del.reset()}>
                {(del.error as Error)?.message ?? 'Could not remove the device.'}
              </Alert>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>Remove “{device.name}”?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This removes the device from Extended WLED Controller only — its own settings and presets
            on the controller are untouched. Fixtures mapped to it stay on the layout but stop
            receiving output.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={del.isPending}
            onClick={() =>
              del.mutate(device.id, {
                onSuccess: () => navigate('/devices'),
                onSettled: () => setConfirmDelete(false),
              })
            }
          >
            {del.isPending ? 'Removing…' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>

      <Typography variant="caption" color="text.secondary" sx={{ color: md3.onSurfaceVariant }}>
        DMX start address {device.dmxStartAddress} · universe {device.realtime.dmxUniverse ?? '—'} · realtime
        timeout {device.realtime.timeoutMs ? `${device.realtime.timeoutMs} ms` : '—'} · last import{' '}
        {device.lastImportAt ? new Date(device.lastImportAt).toLocaleString() : '—'}
      </Typography>

      <NodeImportDialog sourceId={id} open={nodeImportOpen} onClose={() => setNodeImportOpen(false)} />
    </Stack>
  );
}

function WhiteBalanceCard({
  deviceId,
  hasWhiteChannel,
}: {
  deviceId: number;
  hasWhiteChannel: boolean;
}) {
  const { data: status } = useStreamStatus();
  const setConfig = useSetStreamConfig();
  const wb = status?.devices.find((d) => d.deviceId === deviceId)?.whiteBalance ?? null;
  const enabled = wb?.enabled ?? false;

  const [kelvin, setKelvin] = useState(wb?.kelvin ?? WHITE_BALANCE_NEUTRAL_K);
  // Only adopt a server value that isn't just an echo of our own last commit —
  // otherwise the ~5 s idle poll snaps the slider back mid-adjust.
  const lastCommitted = useRef(kelvin);
  useEffect(() => {
    if (wb?.kelvin != null && wb.kelvin !== lastCommitted.current) {
      lastCommitted.current = wb.kelvin;
      setKelvin(wb.kelvin);
    }
  }, [wb?.kelvin]);

  const commit = (next: { enabled: boolean; kelvin: number }) => {
    lastCommitted.current = next.kelvin;
    setConfig.mutate({ deviceId, whiteBalance: next.enabled ? next : null });
  };

  const gain = kelvinToRgbGain(kelvin);
  const swatch = enabled
    ? `rgb(${gain.map((g) => Math.round(255 * g)).join(', ')})`
    : md3.surfaceContainerHighest;

  return (
    <Card>
      <CardContent>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
          <Box>
            <Typography variant="h4">White balance</Typography>
            <Typography variant="body2" color="text.secondary">
              Correct the white point of an RGB strip with no white channel. Applied to the realtime
              stream (Scenes, painter, solid) and mirrored on the Scenes preview — it never changes
              the device&apos;s own presets.
            </Typography>
          </Box>
          <Switch
            checked={enabled}
            disabled={hasWhiteChannel}
            onChange={(e) => commit({ enabled: e.target.checked, kelvin })}
          />
        </Stack>

        {hasWhiteChannel ? (
          <Alert severity="info" sx={{ mt: 2 }}>
            This device has a hardware white channel — use its colour-temperature control instead.
          </Alert>
        ) : (
          <Box
            sx={{
              mt: 2,
              opacity: enabled ? 1 : 0.45,
              pointerEvents: enabled ? 'auto' : 'none',
            }}
          >
            <Stack direction="row" spacing={2} alignItems="center">
              <Box
                sx={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  borderRadius: 1,
                  bgcolor: swatch,
                  border: `1px solid ${md3.outline}`,
                }}
              />
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle2" gutterBottom>
                  {kelvin} K
                  {kelvin === WHITE_BALANCE_NEUTRAL_K && (
                    <Typography component="span" variant="caption" color="text.secondary">
                      {' '}
                      · neutral
                    </Typography>
                  )}
                </Typography>
                <CommittedSlider
                  min={WHITE_BALANCE_MIN_K}
                  max={WHITE_BALANCE_MAX_K}
                  step={100}
                  marks={[2700, 4000, WHITE_BALANCE_NEUTRAL_K, 10000].map((v) => ({
                    value: v,
                    label: String(v),
                  }))}
                  value={kelvin}
                  formatValue={(v) => `${v} K`}
                  valueLabelDisplay="auto"
                  onCommit={(v) => {
                    setKelvin(v);
                    commit({ enabled: true, kelvin: v });
                  }}
                />
              </Box>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Warmer (&lt; {WHITE_BALANCE_NEUTRAL_K} K) knocks back green &amp; blue; cooler knocks
              back red. The swatch shows what a full-white pixel becomes on the wire.
            </Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

function CctControl({
  segment,
  onChange,
}: {
  segment: WledSegment;
  onChange: (p: Partial<WledSegment>) => void;
}) {
  const raw = typeof segment.cct === 'number' ? segment.cct : 127;
  const kelvin = cctIsKelvin(raw);
  return (
    <Box>
      <Divider textAlign="left" sx={{ mb: 2 }}>
        <Typography variant="overline" color="text.secondary">
          Colour temperature {kelvin ? '(Kelvin)' : '(relative)'}
        </Typography>
      </Divider>
      <CommittedSlider
        min={kelvin ? CCT_KELVIN_MIN : 0}
        max={kelvin ? CCT_KELVIN_MAX : 255}
        value={raw}
        valueLabelDisplay="auto"
        formatValue={(v) => (kelvin ? `${v}K` : `${Math.round((v / 255) * 100)}%`)}
        onCommit={(v) => onChange({ cct: v })}
      />
    </Box>
  );
}
