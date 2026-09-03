import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
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
import {
  useAssignDmx,
  useDmxPatch,
  useReplanDmx,
  useSetDmxConfig,
  useSetDmxManaged,
  useSetPixelOffset,
  useStartPattern,
  useStartSolid,
  useStopStream,
  useStreamStatus,
} from '../api/stage.js';
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
            <Typography variant="h4">DMX / E1.31 patch</Typography>
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
              <TableCell align="right">Start univ.</TableCell>
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

function StreamTestCard() {
  const { data: status } = useStreamStatus();
  const startSolid = useStartSolid();
  const startPattern = useStartPattern();
  const stopStream = useStopStream();
  const setOffset = useSetPixelOffset();
  const [color, setColor] = useState('#00b4c8');

  const running = status?.running ?? false;
  const mode = status?.mode ?? 'idle';

  return (
    <Card>
      <CardContent>
        <Typography variant="h4" gutterBottom>
          DDP transport test
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Streams to every device at 40 fps over DDP — the milestone-3 proof that the whole
          transport works end to end. <b>Solid</b> checks that frames render; the{' '}
          <b>alignment pattern</b> (LED&nbsp;0 white, 1 red, 2 green, last blue, rest a dim ramp)
          is the one that reveals a ±1 offset or a reversed run. Effects come in milestone 4.
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
            {mode === 'solid' ? 'Streaming solid' : 'Stream solid'}
          </Button>
          <Button
            variant={mode === 'pattern' ? 'contained' : 'outlined'}
            startIcon={<PlayArrowIcon />}
            onClick={() => startPattern.mutate()}
          >
            {mode === 'pattern' ? 'Streaming pattern' : 'Stream alignment pattern'}
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
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Device</TableCell>
                  <TableCell align="right">Sent</TableCell>
                  <TableCell align="right">Dropped</TableCell>
                  <TableCell align="right">Device fps</TableCell>
                  <TableCell align="center">Pixel offset</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {status.devices.map((d) => (
                  <TableRow key={d.deviceId}>
                    <TableCell>
                      {d.name}{' '}
                      <Typography component="span" variant="caption" color="text.secondary">
                        · {d.connection}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{d.framesSent}</TableCell>
                    <TableCell align="right" sx={{ color: d.framesDropped > 0 ? md3.warning : undefined }}>
                      {d.framesDropped}
                    </TableCell>
                    <TableCell align="right">{d.deviceFps ?? '—'}</TableCell>
                    <TableCell align="center">
                      <Stack direction="row" spacing={0.5} justifyContent="center" alignItems="center">
                        <Button
                          size="small"
                          onClick={() => setOffset.mutate({ deviceId: d.deviceId, offset: d.pixelOffset - 1 })}
                        >
                          −1
                        </Button>
                        <Typography variant="body2" sx={{ minWidth: 24, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Typography variant="caption" color="text.secondary">
              Stream the alignment pattern and watch the strip: the first physical LED should be
              the white one. If it isn&apos;t, nudge the pixel offset ±1 until it lines up.
            </Typography>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function StagePage() {
  return (
    <Stack spacing={3}>
      <Typography variant="h2">Stage</Typography>
      <DmxPatchCard />
      <StreamTestCard />
    </Stack>
  );
}
