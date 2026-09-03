import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import { useDiscoverNodes, useImportNodes } from '../api/devices.js';

/**
 * Reads `/json/nodes` from one registered device and offers to add the peers it
 * has discovered. "Adding one device by IP should offer to import the rest."
 */
export function NodeImportDialog({
  sourceId,
  open,
  onClose,
}: {
  sourceId: number;
  open: boolean;
  onClose: () => void;
}) {
  const discover = useDiscoverNodes(sourceId);
  const importNodes = useImportNodes();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      importNodes.reset();
      setSelected(new Set());
      void discover.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const candidates = discover.data ?? [];
  const importable = candidates.filter((c) => !c.alreadyRegistered);

  const toggle = (host: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(host) ? next.delete(host) : next.add(host);
      return next;
    });

  const submit = async () => {
    const res = await importNodes.mutateAsync({ hosts: [...selected] });
    if (res.failed.length === 0) onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Devices on the network</DialogTitle>
      <DialogContent>
        {discover.isFetching && (
          <Stack alignItems="center" py={3}>
            <CircularProgress size={28} />
          </Stack>
        )}

        {discover.isError && (
          <Alert severity="error">{(discover.error as Error)?.message ?? 'Could not read /json/nodes.'}</Alert>
        )}

        {!discover.isFetching && !discover.isError && candidates.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            This device has not discovered any peers. Node discovery must be enabled on the WLED
            devices for this to work.
          </Typography>
        )}

        {importable.length > 0 && (
          <List dense>
            {importable.map((c) => (
              <ListItem key={c.host} disablePadding>
                <ListItemButton onClick={() => toggle(c.host)} dense>
                  <Checkbox edge="start" checked={selected.has(c.host)} tabIndex={-1} disableRipple />
                  <ListItemText primary={c.name ?? c.host} secondary={c.name ? c.host : undefined} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}

        {candidates.some((c) => c.alreadyRegistered) && (
          <Typography variant="caption" color="text.secondary">
            {candidates.filter((c) => c.alreadyRegistered).length} already registered and hidden.
          </Typography>
        )}

        {importNodes.data && importNodes.data.failed.length > 0 && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {importNodes.data.failed.map((f) => `${f.host}: ${f.error}`).join('; ')}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="contained"
          disabled={selected.size === 0 || importNodes.isPending}
          onClick={() => void submit()}
        >
          {importNodes.isPending ? 'Adding…' : `Add ${selected.size || ''}`.trim()}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
