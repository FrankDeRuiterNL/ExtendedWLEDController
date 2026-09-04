import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import {
  BLEND_MODES,
  effectDefaults,
  getEffect,
  listEffects,
  type BlendMode,
  type CustomEffectSpec,
  type Installation,
  type RecipeLayer,
  type Scene,
} from '@ewc/core';
import { useCreateCustomEffect, useDeleteCustomEffect, useUpdateCustomEffect } from '../api/customEffects.js';
import { CanvasPreview } from './CanvasPreview.js';
import { ParamControl } from './ParamControl.js';

const MAX_LAYERS = 12;
const newLayerId = () => `l-${Math.random().toString(36).slice(2, 9)}`;
export const makeRecipeLayer = (effectId = 'solid'): RecipeLayer => ({
  id: newLayerId(),
  effectId,
  params: effectDefaults(effectId),
  blend: 'normal',
  opacity: 1,
  enabled: true,
  mask: null,
});

interface Props {
  open: boolean;
  onClose: () => void;
  installation?: Installation | null;
  /** `null` when creating a brand new custom effect (no Delete button). */
  editingId: number | null;
  initialName: string;
  initialSpec: CustomEffectSpec;
  onSaved: (id: number) => void;
  onDeleted: () => void;
}

export function RecipeEditorDialog({
  open,
  onClose,
  installation,
  editingId,
  initialName,
  initialSpec,
  onSaved,
  onDeleted,
}: Props) {
  const [name, setName] = useState(initialName);
  const [blurb, setBlurb] = useState(initialSpec.blurb ?? '');
  const [layers, setLayers] = useState<RecipeLayer[]>(initialSpec.layers);
  const [armDelete, setArmDelete] = useState(false);

  const patchLayer = (i: number, patch: Partial<RecipeLayer>) =>
    setLayers((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const moveLayer = (i: number, dir: -1 | 1) =>
    setLayers((ls) => {
      const j = i + dir;
      if (j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const addLayer = () => setLayers((ls) => (ls.length >= MAX_LAYERS ? ls : [...ls, makeRecipeLayer()]));
  const removeLayer = (i: number) => setLayers((ls) => (ls.length <= 1 ? ls : ls.filter((_, j) => j !== i)));

  const draftScene: Scene = useMemo(
    () => ({ name: name.trim() || 'Custom effect', background: [0, 0, 0], layers }),
    [name, layers],
  );

  const createM = useCreateCustomEffect();
  const updateM = useUpdateCustomEffect();
  const deleteM = useDeleteCustomEffect();
  const saving = createM.isPending || updateM.isPending;
  const error = createM.error ?? updateM.error ?? deleteM.error;

  const save = () => {
    const spec: CustomEffectSpec = { blurb: blurb.trim() || undefined, layers };
    const finalName = name.trim() || 'Custom effect';
    if (editingId != null) {
      updateM.mutate({ id: editingId, name: finalName, spec }, { onSuccess: (e) => onSaved(e.id) });
    } else {
      createM.mutate({ name: finalName, spec }, { onSuccess: (e) => onSaved(e.id) });
    }
  };

  const handleClose = () => {
    setArmDelete(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="md">
      <DialogTitle>{editingId != null ? 'Edit custom effect' : 'New custom effect'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Stack direction="row" spacing={2}>
            <TextField
              size="small"
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="Blurb (optional)"
              value={blurb}
              onChange={(e) => setBlurb(e.target.value)}
              sx={{ flex: 2 }}
            />
          </Stack>

          <Card variant="outlined">
            <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
              <CanvasPreview scene={draftScene} installation={installation} playing />
            </CardContent>
          </Card>

          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h6">Layers</Typography>
            <Button size="small" startIcon={<AddIcon />} onClick={addLayer} disabled={layers.length >= MAX_LAYERS}>
              Add layer
            </Button>
          </Stack>

          <Stack spacing={1.5}>
            {layers.map((layer, i) => {
              const def = getEffect(layer.effectId);
              return (
                <Card key={layer.id} variant="outlined">
                  <CardContent>
                    <Stack spacing={1.5}>
                      <Stack direction="row" alignItems="center" justifyContent="space-between">
                        <Typography variant="subtitle2">Layer {i + 1}</Typography>
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Switch
                            size="small"
                            checked={layer.enabled}
                            onChange={(e) => patchLayer(i, { enabled: e.target.checked })}
                          />
                          <IconButton size="small" disabled={i === 0} onClick={() => moveLayer(i, -1)}>
                            <ArrowUpwardIcon fontSize="inherit" />
                          </IconButton>
                          <IconButton size="small" disabled={i === layers.length - 1} onClick={() => moveLayer(i, 1)}>
                            <ArrowDownwardIcon fontSize="inherit" />
                          </IconButton>
                          <IconButton size="small" disabled={layers.length <= 1} onClick={() => removeLayer(i)}>
                            <DeleteOutlineIcon fontSize="inherit" />
                          </IconButton>
                        </Stack>
                      </Stack>

                      <TextField
                        select
                        size="small"
                        label="Effect"
                        value={layer.effectId}
                        onChange={(e) => patchLayer(i, { effectId: e.target.value, params: effectDefaults(e.target.value) })}
                      >
                        {listEffects().map((e) => (
                          <MenuItem key={e.id} value={e.id}>
                            {e.name}
                          </MenuItem>
                        ))}
                      </TextField>

                      <TextField
                        select
                        size="small"
                        label="Blend"
                        value={layer.blend}
                        onChange={(e) => patchLayer(i, { blend: e.target.value as BlendMode })}
                      >
                        {BLEND_MODES.map((b) => (
                          <MenuItem key={b.value} value={b.value}>
                            {b.label}
                          </MenuItem>
                        ))}
                      </TextField>

                      <Box>
                        <Stack direction="row" justifyContent="space-between">
                          <Typography variant="body2">Opacity</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {Math.round(layer.opacity * 100)}%
                          </Typography>
                        </Stack>
                        <Box sx={{ px: 0.5 }}>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={layer.opacity}
                            onChange={(e) => patchLayer(i, { opacity: Number(e.target.value) })}
                            style={{ width: '100%' }}
                          />
                        </Box>
                      </Box>

                      {(def?.params ?? []).map((d) => (
                        <ParamControl
                          key={d.key}
                          def={d}
                          value={layer.params[d.key]}
                          onChange={(v) => patchLayer(i, { params: { ...layer.params, [d.key]: v } })}
                        />
                      ))}

                      <Divider>
                        <Typography variant="caption" color="text.secondary">
                          Mask
                        </Typography>
                      </Divider>
                      <Stack direction="row" alignItems="center" justifyContent="space-between">
                        <Typography variant="body2">Use an effect as a mask</Typography>
                        <Switch
                          size="small"
                          checked={!!layer.mask}
                          onChange={(e) =>
                            patchLayer(i, {
                              mask: e.target.checked ? { effectId: 'gradient', params: effectDefaults('gradient') } : null,
                            })
                          }
                        />
                      </Stack>
                      {layer.mask && (
                        <>
                          <TextField
                            select
                            size="small"
                            label="Mask effect"
                            value={layer.mask.effectId}
                            onChange={(e) =>
                              patchLayer(i, {
                                mask: {
                                  effectId: e.target.value,
                                  params: effectDefaults(e.target.value),
                                  invert: layer.mask?.invert,
                                },
                              })
                            }
                          >
                            {listEffects().map((e) => (
                              <MenuItem key={e.id} value={e.id}>
                                {e.name}
                              </MenuItem>
                            ))}
                          </TextField>
                          <Stack direction="row" alignItems="center" justifyContent="space-between">
                            <Typography variant="body2">Invert mask</Typography>
                            <Switch
                              size="small"
                              checked={!!layer.mask.invert}
                              onChange={(e) => patchLayer(i, { mask: { ...layer.mask!, invert: e.target.checked } })}
                            />
                          </Stack>
                          {(getEffect(layer.mask.effectId)?.params ?? []).map((d) => (
                            <ParamControl
                              key={d.key}
                              def={d}
                              value={layer.mask!.params[d.key]}
                              onChange={(v) =>
                                patchLayer(i, { mask: { ...layer.mask!, params: { ...layer.mask!.params, [d.key]: v } } })
                              }
                            />
                          ))}
                        </>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              );
            })}
          </Stack>

          {error && <Alert severity="error">{(error as Error).message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {editingId != null && (
          <Button
            color="error"
            onClick={() => {
              if (!armDelete) {
                setArmDelete(true);
                return;
              }
              deleteM.mutate(editingId, { onSuccess: onDeleted });
            }}
            disabled={deleteM.isPending}
            sx={{ mr: 'auto' }}
          >
            {armDelete ? 'Confirm delete' : 'Delete'}
          </Button>
        )}
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving || layers.length === 0}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
