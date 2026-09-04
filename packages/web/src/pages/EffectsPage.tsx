import { useMemo, useState } from 'react';
import { Box, Button, Card, CardActionArea, CardContent, Divider, Stack, Switch, Typography } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import {
  effectDefaults,
  getEffect,
  listEffects,
  type CustomEffectDTO,
  type CustomEffectSpec,
  type EffectDef,
  type ParamValues,
  type Scene,
} from '@ewc/core';
import { useInstallation } from '../api/stage.js';
import { customEffectsMap, useCustomEffects } from '../api/customEffects.js';
import { CanvasPreview } from '../components/CanvasPreview.js';
import { EffectSwatch } from '../components/EffectSwatch.js';
import { ParamControl } from '../components/ParamControl.js';
import { makeRecipeLayer, RecipeEditorDialog } from '../components/RecipeEditorDialog.js';
import { md3 } from '../theme/tokens.js';

interface EditorSeed {
  editingId: number | null;
  name: string;
  spec: CustomEffectSpec;
}

export function EffectsPage() {
  const allEffects = useMemo(() => listEffects(), []);
  const defaultsById = useMemo(
    () => new Map(allEffects.map((e) => [e.id, effectDefaults(e.id)] as const)),
    [allEffects],
  );

  const { data: installation } = useInstallation();
  const { data: customs } = useCustomEffects();
  const customMap = useMemo(() => customEffectsMap(customs), [customs]);

  const [selectedId, setSelectedId] = useState(allEffects[0]?.id ?? '');
  const isCustomSelected = selectedId.startsWith('custom:');
  const selectedDef: EffectDef | undefined = getEffect(selectedId) ?? customMap.get(selectedId);
  const selectedCustomRow: CustomEffectDTO | undefined = customs?.find((c) => `custom:${c.id}` === selectedId);
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

  // --- custom-effect editor ------------------------------------------------
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null);

  const openNew = () => {
    setEditorSeed({ editingId: null, name: '', spec: { layers: [makeRecipeLayer('solid')] } });
    setEditorKey((k) => k + 1);
    setEditorOpen(true);
  };
  const openDuplicate = () => {
    if (!selectedDef || isCustomSelected) return;
    setEditorSeed({
      editingId: null,
      name: `${selectedDef.name} copy`,
      spec: { layers: [{ ...makeRecipeLayer(selectedDef.id), params }] },
    });
    setEditorKey((k) => k + 1);
    setEditorOpen(true);
  };
  const openEdit = () => {
    if (!selectedCustomRow) return;
    setEditorSeed({
      editingId: selectedCustomRow.id,
      name: selectedCustomRow.name,
      spec: { blurb: selectedCustomRow.blurb, layers: selectedCustomRow.layers },
    });
    setEditorKey((k) => k + 1);
    setEditorOpen(true);
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h3">Effects</Typography>
        <Typography variant="body2" color="text.secondary">
          Browse every built-in effect and preview it against your real fixture layout with its
          parameters live-editable — the same preview and controls Scenes uses. This never touches
          the wire; add an FX layer on Scenes to stream one. Build your own by stacking effects, or
          duplicate a built-in to retune its parameters.
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
                customEffects={customMap}
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

          {selectedDef && !isCustomSelected && (
            <Card>
              <CardContent>
                <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
                  <Box>
                    <Typography variant="h5">{selectedDef.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {selectedDef.blurb}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    <Button size="small" startIcon={<ContentCopyIcon />} onClick={openDuplicate}>
                      Duplicate
                    </Button>
                    <Button size="small" startIcon={<RestartAltIcon />} onClick={resetParams} disabled={!dirty}>
                      Reset
                    </Button>
                  </Stack>
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

          {selectedDef && isCustomSelected && (
            <Card>
              <CardContent>
                <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
                  <Box>
                    <Typography variant="h5">{selectedDef.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {selectedDef.blurb}
                    </Typography>
                  </Box>
                  <Button size="small" startIcon={<EditIcon />} onClick={openEdit}>
                    Edit
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                  A custom effect's look is baked into its recipe — edit its layers to change how it
                  looks; there's nothing to tune from here.
                </Typography>
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
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h5">Gallery</Typography>
            <Button size="small" startIcon={<AddIcon />} onClick={openNew}>
              New
            </Button>
          </Stack>
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

          {!!customs?.length && (
            <>
              <Divider>
                <Typography variant="caption" color="text.secondary">
                  Custom
                </Typography>
              </Divider>
              {customs.map((c) => {
                const id = `custom:${c.id}`;
                const def = customMap.get(id);
                if (!def) return null;
                return (
                  <Card key={id} variant="outlined" sx={{ borderColor: id === selectedId ? md3.primary : undefined }}>
                    <CardActionArea onClick={() => selectEffect(id)}>
                      <CardContent sx={{ p: 1.5 }}>
                        <EffectSwatch effect={def} params={{}} />
                        <Typography variant="subtitle2" sx={{ mt: 1 }}>
                          {c.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {c.blurb || `${c.layers.length} layer${c.layers.length === 1 ? '' : 's'}`}
                        </Typography>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                );
              })}
            </>
          )}
        </Stack>
      </Box>

      {editorSeed && (
        <RecipeEditorDialog
          key={editorKey}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          installation={installation}
          editingId={editorSeed.editingId}
          initialName={editorSeed.name}
          initialSpec={editorSeed.spec}
          onSaved={(id) => {
            setEditorOpen(false);
            selectEffect(`custom:${id}`);
          }}
          onDeleted={() => {
            setEditorOpen(false);
            selectEffect(allEffects[0]?.id ?? '');
          }}
        />
      )}
    </Stack>
  );
}
