import { useRef, useState } from 'react';
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
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import RestoreIcon from '@mui/icons-material/Restore';
import {
  useAssignDmx,
  useDmxPatch,
  useReplanDmx,
  useSetDmxConfig,
  useSetDmxManaged,
  useSetPixelOffset,
  useSetStreamConfig,
  useStartPattern,
  useStartSolid,
  useStartSolidDevice,
  useStopStream,
  useStreamStatus,
} from '../api/stage.js';
import { downloadBackup, serverUptime, useRestoreBackup, waitForRestart } from '../api/system.js';
import { md3 } from '../theme/tokens.js';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const rgbToHex = (c: [number, number, number]) =>
  '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');

function DmxPatchCard() {
  const { data: patch } = useDmxPatch();
  const replan = useReplanDmx();
  const setConfig = useSetDmxConfig();
  const assign = useAssignDmx();
  const setManaged = useSetDmxManaged();

  if (!patch) return null;

  return (
    <Card>
      <CardContent>
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
          <Box>
            <Typography variant="h4">DMX / E1.31 Device Patch</Typography>
            <Typography variant="body2" color="text.secondary">
              The app assigns each device a universe block and writes it to the controller.
              {patch.highestUniverse > 0 && ` Universes 1–${patch.highestUniverse} in use.`}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              select
              size="small"
              label="Packing"
              value={patch.config.packing}
              onChange={(e) => setConfig.mutate({ config: { packing: e.target.value as 'boundary' | 'packed' }, replan: true })}
              sx={{ minWidth: 150 }}
            >
              <MenuItem value="boundary">Universe boundary</MenuItem>
              <MenuItem value="packed">Packed</MenuItem>
            </TextField>
            <Button
              startIcon={<AutorenewIcon />}
              onClick={() => replan.mutate()}
              disabled={replan.isPending}
              variant="outlined"
            >
              Re-plan &amp; push
            </Button>
          </Stack>
        </Stack>

        {patch.conflicts.length > 0 && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {patch.conflicts.map((c, i) => (
              <div key={i}>
                {c.nameA} and {c.nameB} overlap on universe{c.universes[0] === c.universes[1] ? '' : 's'}{' '}
                {c.universes[0]}
                {c.universes[0] !== c.universes[1] && `–${c.universes[1]}`}
              </div>
            ))}
          </Alert>
        )}

        <Table size="small" sx={{ mt: 2 }}>
          <TableHead>
            <TableRow>
              <TableCell>Device</TableCell>
              <TableCell align="right">LEDs</TableCell>
              <TableCell align="right">Universe</TableCell>
              <TableCell align="right">Start addr</TableCell>
              <TableCell align="center">Managed</TableCell>
              <TableCell align="center">State</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {patch.entries.map((e) => {
              const a = e.allocation;
              return (
                <TableRow key={e.deviceId}>
                  <TableCell>{e.name}</TableCell>
                  <TableCell align="right">{e.ledCount ?? '—'}</TableCell>
                  <TableCell align="right">
                    {a ? (a.universeCount === 1 ? a.firstUniverse : `${a.firstUniverse}–${a.firstUniverse + a.universeCount - 1}`) : '—'}
                  </TableCell>
                  <TableCell align="right">{a?.startChannel ?? e.deviceReports.startAddress}</TableCell>
                  <TableCell align="center">
                    <Switch
                      size="small"
                      checked={e.managed}
                      onChange={(ev) => setManaged.mutate({ deviceId: e.deviceId, managed: ev.target.checked })}
                    />
                  </TableCell>
                  <TableCell align="center">
                    {e.writeError ? (
                      <Tooltip title={e.writeError}>
                        <Chip size="small" color="error" label="write failed" />
                      </Tooltip>
                    ) : e.inSync ? (
                      <Chip size="small" color="success" variant="outlined" label="in sync" />
                    ) : e.managed ? (
                      <Chip size="small" color="warning" variant="outlined" label="out of sync" />
                    ) : (
                      <Chip size="small" variant="outlined" label="—" />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {e.managed && (
                      <Button size="small" onClick={() => assign.mutate(e.deviceId)} disabled={assign.isPending}>
                        Re-push
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {patch.entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography variant="body2" color="text.secondary">
                    No devices yet.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

const FPS_CAPS = [30, 25, 20, 15, 10, 5];

function StreamTestCard() {
  const { data: status } = useStreamStatus();
  const startSolid = useStartSolid();
  const startSolidDevice = useStartSolidDevice();
  const startPattern = useStartPattern();
  const stopStream = useStopStream();
  const setOffset = useSetPixelOffset();
  const setStreamConfig = useSetStreamConfig();
  const [color, setColor] = useState('#00b4c8');

  const running = status?.running ?? false;
  const mode = status?.mode ?? 'idle';
  const soloDevice =
    running && mode === 'solid' && status
      ? (() => {
          const lit = status.devices.filter((d) => d.framesSent > 0);
          return lit.length === 1 ? lit[0]!.deviceId : null;
        })()
      : null;

  return (
    <Card>
      <CardContent>
        <Typography variant="h4" gutterBottom>
          DDP Settings &amp; Test
        </Typography>

        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <Box
            component="label"
            sx={{
              width: 48, height: 48, borderRadius: 2, border: `1px solid ${md3.outline}`,
              overflow: 'hidden', cursor: 'pointer', bgcolor: color,
            }}
          >
            <input
              type="color"
              value={color}
              onChange={(e) => {
                setColor(e.target.value);
                if (running && mode === 'solid') startSolid.mutate(hexToRgb(e.target.value));
              }}
              style={{ opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
            />
          </Box>
          <Button
            variant={mode === 'solid' ? 'contained' : 'outlined'}
            startIcon={<PlayArrowIcon />}
            onClick={() => startSolid.mutate(hexToRgb(color))}
          >
            {mode === 'solid' ? 'Test All active' : 'Enable Test All'}
          </Button>
          <Button
            variant={mode === 'pattern' ? 'contained' : 'outlined'}
            startIcon={<PlayArrowIcon />}
            onClick={() => startPattern.mutate()}
          >
            {mode === 'pattern' ? 'Alignment Pattern active' : 'Enable Alignment Pattern'}
          </Button>
          {running && (
            <Button variant="outlined" color="error" startIcon={<StopIcon />} onClick={() => stopStream.mutate()}>
              Stop &amp; release
            </Button>
          )}
          {running && <Chip color="success" label={`streaming · ${status?.fps ?? 40} fps`} />}
        </Stack>

        {status && status.devices.length > 0 && (
          <>
            <Divider sx={{ my: 2 }} />
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ minWidth: 720 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Device</TableCell>
                    <TableCell>Transport</TableCell>
                    <TableCell>Rate cap</TableCell>
                    <TableCell align="center">Pixel offset</TableCell>
                    <TableCell align="center">Test</TableCell>
                    <TableCell align="right">Live</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {status.devices.map((d) => {
                    const streamingThis = running && d.framesSent > 0;
                    return (
                      <TableRow key={d.deviceId}>
                        <TableCell>
                          {d.name}{' '}
                          <Typography component="span" variant="caption" color="text.secondary">
                            · {d.connection}
                            {d.ledCount != null && ` · ${d.ledCount} LEDs`}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <TextField
                            select
                            size="small"
                            variant="standard"
                            value={d.transport}
                            onChange={(e) =>
                              setStreamConfig.mutate({
                                deviceId: d.deviceId,
                                transport: e.target.value as 'ddp' | 'dnrgb',
                              })
                            }
                            sx={{ minWidth: 104 }}
                          >
                            <MenuItem value="ddp">DDP</MenuItem>
                            <MenuItem value="dnrgb">Legacy UDP</MenuItem>
                          </TextField>
                        </TableCell>
                        <TableCell>
                          <TextField
                            select
                            size="small"
                            variant="standard"
                            value={d.maxFps ?? 0}
                            onChange={(e) =>
                              setStreamConfig.mutate({
                                deviceId: d.deviceId,
                                maxFps: Number(e.target.value) || null,
                              })
                            }
                            sx={{ minWidth: 92 }}
                          >
                            <MenuItem value={0}>Uncapped</MenuItem>
                            {FPS_CAPS.map((f) => (
                              <MenuItem key={f} value={f}>
                                {f} fps
                              </MenuItem>
                            ))}
                          </TextField>
                        </TableCell>
                        <TableCell align="center">
                          <Stack direction="row" spacing={0.5} justifyContent="center" alignItems="center">
                            <Button
                              size="small"
                              onClick={() => setOffset.mutate({ deviceId: d.deviceId, offset: d.pixelOffset - 1 })}
                            >
                              −1
                            </Button>
                            <Typography
                              variant="body2"
                              sx={{ minWidth: 24, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
                            >
                              {d.pixelOffset > 0 ? `+${d.pixelOffset}` : d.pixelOffset}
                            </Typography>
                            <Button
                              size="small"
                              onClick={() => setOffset.mutate({ deviceId: d.deviceId, offset: d.pixelOffset + 1 })}
                            >
                              +1
                            </Button>
                            {d.pixelOffset !== 0 && (
                              <Button
                                size="small"
                                color="inherit"
                                onClick={() => setOffset.mutate({ deviceId: d.deviceId, offset: 0 })}
                              >
                                reset
                              </Button>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell align="center">
                          <Button
                            size="small"
                            variant={soloDevice === d.deviceId ? 'contained' : 'outlined'}
                            onClick={() =>
                              startSolidDevice.mutate({ deviceId: d.deviceId, color: hexToRgb(color) })
                            }
                          >
                            {soloDevice === d.deviceId ? 'Solid ✓' : 'Solid'}
                          </Button>
                        </TableCell>
                        <TableCell align="right">
                          {streamingThis ? (
                            <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                              {d.deviceFps != null && `${d.deviceFps} fps · `}
                              {d.framesSent} sent
                              {d.framesDropped > 0 && (
                                <Box component="span" sx={{ color: md3.warning }}> · {d.framesDropped} drop</Box>
                              )}
                            </Typography>
                          ) : (
                            <Typography variant="caption" color="text.disabled">
                              idle
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              <b>Transport:</b> DDP is the default; switch to <b>Legacy UDP</b> (DNRGB on
              port&nbsp;21324) only as a fallback for a device DDP won&apos;t drive — it&apos;s RGB
              only, so a white channel stays dark. <b>Rate cap</b> throttles that device&apos;s send
              rate to spare a slower controller. Stream the alignment pattern and nudge the pixel
              offset ±1 until the first physical LED is the white one.
            </Typography>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MaintenanceCard() {
  const restore = useRestoreBackup();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'timeout'>('idle');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ''; // let the same file be picked again after a cancel
    if (file) {
      setError(null);
      setPending(file);
    }
  };

  const doDownload = async () => {
    setError(null);
    setDownloading(true);
    try {
      await downloadBackup();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  const doRestore = async () => {
    if (!pending) return;
    const file = pending;
    setPending(null);
    setError(null);
    try {
      const baseline = await serverUptime();
      await restore.mutateAsync(file);
      setPhase('restarting');
      const back = await waitForRestart(baseline);
      if (back) window.location.reload();
      else setPhase('timeout');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h4" gutterBottom>
          Backup &amp; Restore
        </Typography>

        {phase === 'restarting' ? (
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 1 }}>
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">
              Backup restored — the app is restarting. This page reloads automatically when it&apos;s back.
            </Typography>
          </Stack>
        ) : phase === 'timeout' ? (
          <Alert severity="warning">
            The backup was restored, but the app is taking a while to restart. Reload this page in a
            moment.
          </Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              A backup is a single <code>.zip</code> holding the whole database (devices, scenes,
              rundown, layout, DDP settings) plus every uploaded image and the floorplan. Restoring
              one replaces <b>all</b> current data and restarts the app.
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                variant="outlined"
                startIcon={<CloudDownloadIcon />}
                onClick={doDownload}
                disabled={downloading || restore.isPending}
              >
                {downloading ? 'Preparing…' : 'Download backup'}
              </Button>
              <Button
                variant="outlined"
                color="error"
                startIcon={<RestoreIcon />}
                onClick={() => fileInput.current?.click()}
                disabled={downloading || restore.isPending}
              >
                Restore from backup…
              </Button>
            </Stack>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={pickFile}
            />
          </>
        )}
      </CardContent>

      <Dialog open={pending != null} onClose={() => !restore.isPending && setPending(null)}>
        <DialogTitle>Restore from backup?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <p>
              <b>{pending?.name}</b>
            </p>
            <p>
              This replaces <b>all current data</b> — every device, scene, rundown, the layout, DDP
              settings and every uploaded image — with the contents of this backup. There is no undo,
              and the app will restart.
            </p>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button disabled={restore.isPending} onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={restore.isPending}
            onClick={doRestore}
          >
            {restore.isPending ? 'Restoring…' : 'Overwrite everything'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

export function StagePage() {
  return (
    <Stack spacing={3}>
      <Typography variant="h2">System</Typography>
      <DmxPatchCard />
      <StreamTestCard />
      <MaintenanceCard />
    </Stack>
  );
}
