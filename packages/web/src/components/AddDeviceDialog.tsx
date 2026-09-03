import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material';
import type { LinkType } from '@ewc/core';
import { useAddDevice } from '../api/devices.js';
import { ApiError } from '../api/client.js';

const LINK_TYPES: { value: LinkType; label: string }[] = [
  { value: 'unknown', label: 'Unknown / not sure' },
  { value: 'wifi', label: 'Wi-Fi' },
  { value: 'ethernet', label: 'Wired Ethernet' },
];

export function AddDeviceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddDevice();
  const [host, setHost] = useState('');
  const [name, setName] = useState('');
  const [linkType, setLinkType] = useState<LinkType>('unknown');

  const reset = () => {
    setHost('');
    setName('');
    setLinkType('unknown');
    add.reset();
  };

  const submit = async () => {
    try {
      await add.mutateAsync({
        host: host.trim(),
        name: name.trim() || undefined,
        linkType,
      });
      reset();
      onClose();
    } catch {
      /* surfaced below */
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Add a WLED device</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <TextField
            label="IP address or hostname"
            placeholder="10.0.1.50  ·  wled-ramen.local  ·  10.0.1.50:80"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            autoFocus
            fullWidth
            onKeyDown={(e) => {
              if (e.key === 'Enter' && host.trim()) void submit();
            }}
          />
          <TextField
            label="Display name (optional)"
            placeholder="Defaults to the device's own name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
          />
          <TextField
            select
            label="Connection"
            value={linkType}
            onChange={(e) => setLinkType(e.target.value as LinkType)}
            helperText="Used to budget the realtime frame rate in a later milestone."
            fullWidth
          >
            {LINK_TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>
                {t.label}
              </MenuItem>
            ))}
          </TextField>

          {add.isError && (
            <Alert severity="error">
              {add.error instanceof ApiError ? add.error.message : 'Could not add the device.'}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button onClick={() => void submit()} variant="contained" disabled={!host.trim() || add.isPending}>
          {add.isPending ? 'Contacting device…' : 'Add device'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
