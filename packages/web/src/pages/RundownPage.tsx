import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import {
  CUE_FADE_MAX_MS,
  CUE_MIN_DURATION_MS,
  cueTotalMs,
  formatDuration,
  makeCue,
  parseDuration,
  type Cue,
  type CueTrigger,
} from '@ewc/core';
import { useScenes } from '../api/scenes.js';
import {
  useRundown,
  useRundownGo,
  useRundownGoCue,
  useRundownStatus,
  useRundownStop,
  useSaveRundown,
} from '../api/rundown.js';
import { md3 } from '../theme/tokens.js';

const triggerLabel = (t: CueTrigger): string => {
  if (t.type === 'manual') return 'Manual';
  const n = t.seconds === Math.floor(t.seconds) ? String(t.seconds) : t.seconds.toFixed(1);
  return t.type === 'follow' ? `Follow +${n}s` : `Wait +${n}s`;
};

const fadeLabel = (cue: Cue): string => {
  const s = (ms: number) => (ms === 0 ? '—' : `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`);
  return `${s(cue.fadeInMs)} / ${s(cue.fadeOutMs)}`;
};

export function RundownPage() {
  const { data: rundownDto } = useRundown();
  const { data: scenes } = useScenes();
  const { data: status, dataUpdatedAt: statusAt } = useRundownStatus();
  const save = useSaveRundown();
  const go = useRundownGo();
  const goCue = useRundownGoCue();
  const stop = useRundownStop();

  const [cues, setCues] = useState<Cue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  // Load server cues when they change and we have no unsaved edits.
  useEffect(() => {
    if (!rundownDto || dirty) return;
    setCues(rundownDto.rundown.cues);
  }, [rundownDto, dirty]);

  const sceneName = (id: number | null): string => {
    if (id == null) return '— no scene —';
    return scenes?.find((s) => s.id === id)?.name ?? `scene ${id} (deleted)`;
  };

  const mutate = (next: Cue[]) => {
    setCues(next);
    setDirty(true);
  };
  const addCue = () => {
    const cue = makeCue(String(cues.length + 1));
    mutate([...cues, cue]);
    setEditId(cue.id);
  };
  const patchCue = (id: string, p: Partial<Cue>) =>
    mutate(cues.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const removeCue = (id: string) => mutate(cues.filter((c) => c.id !== id));
  const moveCue = (id: string, dir: -1 | 1) => {
    const i = cues.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cues.length) return;
    const next = [...cues];
    [next[i], next[j]] = [next[j]!, next[i]!];
    mutate(next);
  };
  const doSave = () => {
    save.mutate({ cues }, { onSuccess: () => setDirty(false) });
  };
  const revert = () => {
    if (rundownDto) setCues(rundownDto.rundown.cues);
    setDirty(false);
  };

  const editing = cues.find((c) => c.id === editId) ?? null;

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h3">Rundown</Typography>
        <Typography variant="body2" color="text.secondary">
          An ordered list of <strong>cues</strong>. Each cue puts one saved <strong>scene</strong> on
          the stream output — fading in from black, holding for its duration, then fading out. Cues
          advance on <strong>GO</strong>, or automatically off the previous cue. Editing the list
          takes effect on the next GO; a running cue keeps its timing.
        </Typography>
      </Box>

      <TransportBar
        status={status}
        statusAt={statusAt}
        cues={cues}
        onGo={() => go.mutate()}
        onStop={() => stop.mutate()}
        busy={go.isPending || stop.isPending}
        sceneName={sceneName}
      />

      <Card>
        <CardContent>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="h4">Cues</Typography>
            <Stack direction="row" spacing={1}>
              {dirty && (
                <Button size="small" color="inherit" onClick={revert} disabled={save.isPending}>
                  Revert
                </Button>
              )}
              <Button
                size="small"
                variant={dirty ? 'contained' : 'outlined'}
                onClick={doSave}
                disabled={!dirty || save.isPending}
              >
                {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </Button>
              <Button size="small" startIcon={<AddIcon />} onClick={addCue}>
                Add cue
              </Button>
            </Stack>
          </Stack>

          {save.isError && (
            <Alert severity="error" sx={{ mb: 1 }} onClose={() => save.reset()}>
              {(save.error as Error)?.message ?? 'Could not save the rundown.'}
            </Alert>
          )}

          {cues.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No cues yet. <strong>Add cue</strong> to build the running order.
            </Typography>
          ) : (
            <Stack divider={<Divider flexItem />}>
              {/* header row */}
              <Stack
                direction="row"
                spacing={1}
                sx={{ px: 1, py: 0.5, color: 'text.secondary', typography: 'caption' }}
              >
                <Box sx={{ width: 44 }}>#</Box>
                <Box sx={{ flex: 1.4, minWidth: 0 }}>Cue</Box>
                <Box sx={{ flex: 1.4, minWidth: 0 }}>Scene</Box>
                <Box sx={{ flex: 1 }}>Trigger</Box>
                <Box sx={{ width: 90 }}>Fade in/out</Box>
                <Box sx={{ width: 76 }}>Duration</Box>
                <Box sx={{ width: 120 }} />
              </Stack>
              {cues.map((cue, i) => {
                const isCurrent = status?.currentCueId === cue.id;
                const isNext = status?.nextCueId === cue.id && !isCurrent;
                return (
                  <Stack
                    key={cue.id}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={{
                      px: 1,
                      py: 0.75,
                      borderRadius: 1,
                      bgcolor: isCurrent
                        ? `${md3.primary}1f`
                        : isNext
                          ? `${md3.primary}0d`
                          : 'transparent',
                    }}
                  >
                    <Box sx={{ width: 44, fontWeight: 700 }}>{cue.number || i + 1}</Box>
                    <Box sx={{ flex: 1.4, minWidth: 0 }}>
                      <Typography variant="body2" noWrap>
                        {cue.name?.trim() || <span style={{ color: md3.outline }}>Untitled cue</span>}
                      </Typography>
                    </Box>
                    <Box sx={{ flex: 1.4, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        noWrap
                        color={cue.sceneId == null ? 'error' : 'text.primary'}
                      >
                        {sceneName(cue.sceneId)}
                      </Typography>
                    </Box>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        {triggerLabel(cue.trigger)}
                      </Typography>
                    </Box>
                    <Box sx={{ width: 90 }}>
                      <Typography variant="caption" color="text.secondary">
                        {fadeLabel(cue)}
                      </Typography>
                    </Box>
                    <Box sx={{ width: 76 }}>
                      <Typography variant="caption" color="text.secondary">
                        {formatDuration(cue.durationMs)}
                      </Typography>
                    </Box>
                    <Stack direction="row" sx={{ width: 120 }} justifyContent="flex-end">
                      <Tooltip title="GO this cue">
                        <span>
                          <IconButton
                            size="small"
                            color="primary"
                            disabled={cue.sceneId == null || goCue.isPending}
                            onClick={() => goCue.mutate(cue.id)}
                          >
                            <PlayArrowIcon fontSize="inherit" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <IconButton size="small" onClick={() => moveCue(cue.id, -1)} disabled={i === 0}>
                        <ArrowUpwardIcon fontSize="inherit" />
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={() => moveCue(cue.id, 1)}
                        disabled={i === cues.length - 1}
                      >
                        <ArrowDownwardIcon fontSize="inherit" />
                      </IconButton>
                      <IconButton size="small" onClick={() => setEditId(cue.id)}>
                        <EditIcon fontSize="inherit" />
                      </IconButton>
                      <IconButton size="small" onClick={() => removeCue(cue.id)}>
                        <DeleteOutlineIcon fontSize="inherit" />
                      </IconButton>
                    </Stack>
                  </Stack>
                );
              })}
            </Stack>
          )}
        </CardContent>
      </Card>

      {editing && (
        <CueDialog
          cue={editing}
          scenes={scenes ?? []}
          onClose={() => setEditId(null)}
          onChange={(p) => patchCue(editing.id, p)}
        />
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------

function TransportBar({
  status,
  statusAt,
  cues,
  onGo,
  onStop,
  busy,
  sceneName,
}: {
  status: import('@ewc/core').RundownStatusDTO | undefined;
  statusAt: number;
  cues: Cue[];
  onGo: () => void;
  onStop: () => void;
  busy: boolean;
  sceneName: (id: number | null) => string;
}) {
  // Interpolate elapsed / countdown between polls (the status is a wall-clock
  // snapshot taken at `statusAt`) so the bar moves smoothly at 4 Hz.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status?.active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [status?.active]);

  const current = cues.find((c) => c.id === status?.currentCueId) ?? null;
  const nextCue = cues.find((c) => c.id === status?.nextCueId) ?? null;

  const active = status?.active ?? false;
  const phase = status?.phase ?? 'idle';
  const total = status?.cueTotalMs ?? 0;
  const sincePoll = Math.max(0, now - statusAt);
  const elapsed =
    active && status ? Math.min(total || Infinity, status.elapsedMs + sincePoll) : 0;
  const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;

  const countdownMs =
    status?.nextFiresInMs != null ? Math.max(0, status.nextFiresInMs - sincePoll) : null;
  const countdown = countdownMs != null ? Math.ceil(countdownMs / 1000) : null;

  return (
    <Card>
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="large"
              startIcon={<PlayArrowIcon />}
              onClick={onGo}
              disabled={busy || cues.length === 0}
            >
              GO
            </Button>
            <Button
              variant="outlined"
              size="large"
              color="inherit"
              startIcon={<StopIcon />}
              onClick={onStop}
              disabled={busy || !active}
            >
              Stop
            </Button>
          </Stack>

          <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
            {active && current ? (
              <>
                <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                  <Chip size="small" color="primary" label={`Cue ${current.number}`} />
                  <Typography variant="body2" noWrap>
                    {current.name?.trim() || sceneName(current.sceneId)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {phase === 'fade-in'
                      ? 'fading in'
                      : phase === 'fade-out'
                        ? 'fading out'
                        : phase === 'done'
                          ? 'holding at black'
                          : 'live'}
                    {' · '}
                    {formatDuration(elapsed)} / {formatDuration(total)}
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={pct}
                  sx={{ mt: 0.5, height: 6, borderRadius: 3 }}
                />
                <Typography variant="caption" color="text.secondary">
                  {nextCue
                    ? countdown != null
                      ? `Next: cue ${nextCue.number} — auto in ${formatDuration(countdown * 1000)}`
                      : `Next: cue ${nextCue.number} — waiting for GO`
                    : 'Last cue'}
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {cues.length === 0
                  ? 'Add cues below, then press GO.'
                  : nextCue
                    ? `Idle. GO starts cue ${nextCue.number}.`
                    : 'Idle. No playable cue — every cue is missing its scene.'}
              </Typography>
            )}
            {status?.warning && (
              <Typography variant="caption" color="error">
                {status.warning}
              </Typography>
            )}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function CueDialog({
  cue,
  scenes,
  onClose,
  onChange,
}: {
  cue: Cue;
  scenes: import('@ewc/core').SceneSummaryDTO[];
  onClose: () => void;
  onChange: (p: Partial<Cue>) => void;
}) {
  const [durText, setDurText] = useState(formatDuration(cue.durationMs));
  useEffect(() => setDurText(formatDuration(cue.durationMs)), [cue.id]);
  const durMs = parseDuration(durText);
  const durValid = durMs != null && durMs >= CUE_MIN_DURATION_MS;

  const setTrigger = (type: CueTrigger['type']) => {
    if (type === 'manual') onChange({ trigger: { type: 'manual' } });
    else {
      const seconds = cue.trigger.type === 'manual' ? 0 : cue.trigger.seconds;
      onChange({ trigger: { type, seconds } });
    }
  };
  const fadeSecondsField = (label: string, ms: number, key: 'fadeInMs' | 'fadeOutMs') => (
    <TextField
      size="small"
      type="number"
      label={label}
      value={ms / 1000}
      onChange={(e) => {
        const s = Number(e.target.value);
        if (Number.isFinite(s) && s >= 0) {
          onChange({ [key]: Math.min(CUE_FADE_MAX_MS, Math.round(s * 1000)) } as Partial<Cue>);
        }
      }}
      inputProps={{ min: 0, max: CUE_FADE_MAX_MS / 1000, step: 0.5 }}
      helperText="seconds"
    />
  );

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Cue {cue.number || '—'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Stack direction="row" spacing={2}>
            <TextField
              size="small"
              label="Cue number"
              value={cue.number}
              onChange={(e) => onChange({ number: e.target.value })}
              sx={{ width: 120 }}
            />
            <TextField
              size="small"
              label="Name"
              placeholder="optional"
              value={cue.name ?? ''}
              onChange={(e) => onChange({ name: e.target.value })}
              fullWidth
            />
          </Stack>

          <TextField
            select
            size="small"
            label="Target scene"
            value={cue.sceneId ?? ''}
            onChange={(e) =>
              onChange({ sceneId: e.target.value === '' ? null : Number(e.target.value) })
            }
            error={cue.sceneId == null}
            helperText={cue.sceneId == null ? 'A cue does nothing without a scene.' : ' '}
          >
            <MenuItem value="">— no scene —</MenuItem>
            {scenes.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.name}
              </MenuItem>
            ))}
          </TextField>

          <Divider>
            <Typography variant="caption" color="text.secondary">
              Trigger
            </Typography>
          </Divider>
          <Stack direction="row" spacing={2}>
            <TextField
              select
              size="small"
              label="Starts on"
              value={cue.trigger.type}
              onChange={(e) => setTrigger(e.target.value as CueTrigger['type'])}
              sx={{ flex: 1 }}
            >
              <MenuItem value="manual">Manual (GO)</MenuItem>
              <MenuItem value="follow">Follow — after previous cue starts</MenuItem>
              <MenuItem value="wait">Wait — after previous cue finishes</MenuItem>
            </TextField>
            {cue.trigger.type !== 'manual' && (
              <TextField
                size="small"
                type="number"
                label="Delay"
                value={cue.trigger.seconds}
                onChange={(e) => {
                  const s = Number(e.target.value);
                  if (Number.isFinite(s) && s >= 0) {
                    onChange({ trigger: { type: cue.trigger.type, seconds: s } });
                  }
                }}
                inputProps={{ min: 0, step: 0.5 }}
                helperText="seconds"
                sx={{ width: 120 }}
              />
            )}
          </Stack>

          <Divider>
            <Typography variant="caption" color="text.secondary">
              Timing
            </Typography>
          </Divider>
          <Stack direction="row" spacing={2}>
            {fadeSecondsField('Fade in', cue.fadeInMs, 'fadeInMs')}
            <TextField
              size="small"
              label="Duration"
              value={durText}
              onChange={(e) => setDurText(e.target.value)}
              onBlur={() => {
                if (durValid) onChange({ durationMs: durMs! });
                else setDurText(formatDuration(cue.durationMs));
              }}
              error={!durValid}
              helperText={durValid ? 'h:mm:ss, m:ss, or seconds' : 'min 1 second'}
            />
            {fadeSecondsField('Fade out', cue.fadeOutMs, 'fadeOutMs')}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Total run time: {formatDuration(cueTotalMs(cue))} (fade-in + hold + fade-out). When the
            hold ends the output fades to black; a following cue with a <em>Wait</em> trigger starts
            counting from there.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
