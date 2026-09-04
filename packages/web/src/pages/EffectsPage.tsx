import { useMemo, useState } from 'react';
import { Box, Button, Card, CardActionArea, CardContent, Stack, Switch, Typography } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import {
  effectDefaults,
  getEffect,
  listEffects,
  type EffectDef,
  type ParamValues,
  type Scene,
} from '@ewc/core';
import { useInstallation } from '../api/stage.js';
import { CanvasPreview } from '../components/CanvasPreview.js';
import { EffectSwatch } from '../components/EffectSwatch.js';
import { ParamControl } from '../components/ParamControl.js';
import { md3 } from '../theme/tokens.js';

export function EffectsPage() {
  const allEffects = useMemo(() => listEffects(), []);
  const defaultsById = useMemo(
    () => new Map(allEffects.map((e) => [e.id, effectDefaults(e.id)] as const)),
    [allEffects],
  );

  const { data: installation } = useInstallation();

  const [selectedId, setSelectedId] = useState(allEffects[0]?.id ?? '');
  const selectedDef: EffectDef | undefined = getEffect(selectedId);
  const [params, setParams] = useState<ParamValues>(() => defaultsById.get(selectedId) ?? {});

  const selectEffect = (id: string) => {
    setSelectedId(id);
    setParams(defaultsById.get(id) ?? {});
  };
  const resetParams = () => setParams(defaultsById.get(selectedId) ?? {});
  const dirty = JSON.stringify(params) !== JSON.stringify(defaultsById.get(selectedId) ?? {});

  /** Independent of Scenes' own toggles — this page previews effects, not scenes. */
  const [showFloorplan, setShowFloorplan] = useState(() => {
    try {
      return localStorage.getItem('ewc.effects.showFloorplan') === '1';
    } catch {
      return false;
    }
  });
  const toggleFloorplan = (on: boolean) => {
    setShowFloorplan(on);
    try {
      localStorage.setItem('ewc.effects.showFloorplan', on ? '1' : '0');
    } catch {
      /* private mode — no persistence */
    }
  };
  const [showOutput, setShowOutput] = useState(() => {
    try {
      return localStorage.getItem('ewc.effects.showOutput') === '1';
    } catch {
      return false;
    }
  });
  const toggleOutput = (on: boolean) => {
    setShowOutput(on);
    try {
      localStorage.setItem('ewc.effects.showOutput', on ? '1' : '0');
    } catch {
      /* private mode — no persistence */
    }
  };

  const previewScene: Scene = useMemo(
    () => ({
      name: 'Effect preview',
      background: [0, 0, 0],
      layers: selectedDef
        ? [
            {
              id: 'preview',
              effectId: selectedDef.id,
              params,
              blend: 'normal',
              opacity: 1,
              enabled: true,
              mask: null,
            },
          ]
        : [],
    }),
    [selectedDef, params],
  );

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h3">Effects</Typography>
        <Typography variant="body2" color="text.secondary">
          Browse every built-in effect and preview it against your real fixture layout with its
          parameters live-editable — the same preview and controls Scenes uses. This never touches
          the wire; add an FX layer on Scenes to stream one. Custom effects are coming in a later
          update.
        </Typography>
      </Box>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 360px' } }}>
        {/* preview + param inspector */}
        <Stack spacing={2}>
          <Card>
            <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
              <CanvasPreview
                scene={previewScene}
                installation={installation}
                playing
                showFloorplan={showFloorplan}
                showOutputOnly={showOutput}
              />
            </CardContent>
          </Card>
          <Stack direction="row" alignItems="center" spacing={2} sx={{ px: 0.5 }} flexWrap="wrap" useFlexGap>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Switch size="small" checked={showOutput} onChange={(e) => toggleOutput(e.target.checked)} />
              <Typography variant="body2" color="text.secondary">
                Show output
              </Typography>
            </Stack>
            {installation?.floorplan && (
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  size="small"
                  checked={showFloorplan}
                  onChange={(e) => toggleFloorplan(e.target.checked)}
                />
                <Typography variant="body2" color="text.secondary">
                  Show floorplan
                </Typography>
              </Stack>
            )}
          </Stack>

          {selectedDef && (
            <Card>
              <CardContent>
                <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
                  <Box>
                    <Typography variant="h5">{selectedDef.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {selectedDef.blurb}
                    </Typography>
                  </Box>
                  <Button size="small" startIcon={<RestartAltIcon />} onClick={resetParams} disabled={!dirty}>
                    Reset
                  </Button>
                </Stack>

                {selectedDef.params.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                    This effect has no parameters.
                  </Typography>
                ) : (
                  <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                    {selectedDef.params.map((d) => (
                      <ParamControl
                        key={d.key}
                        def={d}
                        value={params[d.key]}
                        onChange={(v) => setParams((p) => ({ ...p, [d.key]: v }))}
                      />
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>
          )}

          {!installation?.fixtures.length && (
            <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
              No fixtures placed yet — add them on the Layout page to see this effect on the plot.
            </Typography>
          )}
        </Stack>

        {/* gallery */}
        <Stack spacing={1.5}>
          <Typography variant="h5">Gallery</Typography>
          {allEffects.map((e) => (
            <Card
              key={e.id}
              variant="outlined"
              sx={{ borderColor: e.id === selectedId ? md3.primary : undefined }}
            >
              <CardActionArea onClick={() => selectEffect(e.id)}>
                <CardContent sx={{ p: 1.5 }}>
                  <EffectSwatch effect={e} params={defaultsById.get(e.id) ?? {}} />
                  <Typography variant="subtitle2" sx={{ mt: 1 }}>
                    {e.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {e.blurb}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}
