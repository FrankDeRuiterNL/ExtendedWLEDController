import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import BoltIcon from '@mui/icons-material/Bolt';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from 'react-router-dom';
import type { DeviceSummaryDTO } from '@ewc/core';
import { useDevices } from '../api/devices.js';
import { AddDeviceDialog } from '../components/AddDeviceDialog.js';
import { StatusDot } from '../components/StatusDot.js';
import { md3 } from '../theme/tokens.js';

function fmtSignal(s: number | null): string {
  if (s === null) return '—';
  return `${s}%`;
}

/** The connectivity pill: Wi-Fi signal, or the ethernet link speed. */
function linkLabel(device: DeviceSummaryDTO): string {
  if (device.linkType === 'ethernet') {
    // WLED doesn't report the negotiated PHY speed; assume 100 Mbps until set.
    return `Ethernet ${device.ethSpeedMbps ?? 100} Mbps`;
  }
  return `Wi-Fi ${fmtSignal(device.health?.wifiSignal ?? null)}`;
}

/** The device's own WLED web UI, landing on its Colors tab. */
function webUiUrl(device: DeviceSummaryDTO): string {
  const port = device.port !== 80 ? `:${device.port}` : '';
  return `http://${device.host}${port}/#Colors`;
}

function DeviceCard({ device }: { device: DeviceSummaryDTO }) {
  const navigate = useNavigate();
  const h = device.health;
  const warnings = device.warnings.filter((w) => w.severity === 'warning');

  return (
    <Card>
      <CardActionArea onClick={() => navigate(`/devices/${device.id}`)}>
        <CardContent sx={{ pb: 0 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
            <StatusDot connection={device.connection} />
            <Typography variant="h5" noWrap sx={{ flex: 1 }}>
              {device.name}
            </Typography>
            {!device.enabled && <Chip size="small" label="disabled" variant="outlined" />}
          </Stack>

          <Typography variant="body2" color="text.secondary">
            {device.host}
            {device.port !== 80 ? `:${device.port}` : ''} · {device.arch ?? '—'} · fw {device.fwVersion ?? '—'}
          </Typography>
        </CardContent>
      </CardActionArea>

      {/* Outside the CardActionArea (a <button>) so the WLED-UI link below is a
          valid, independently clickable <a> rather than nested interactive
          content. */}
      <CardContent sx={{ pt: 1.5 }}>
        <Stack direction="row" flexWrap="wrap" gap={1} alignItems="center">
          <Chip
            size="small"
            variant="outlined"
            label={`${device.ledCount ?? '—'} LED${device.ledCount === 1 ? '' : 's'}`}
          />
          {device.matrix && (
            <Chip size="small" variant="outlined" label={`${device.matrix.w}×${device.matrix.h}`} />
          )}
          <Chip
            size="small"
            variant="outlined"
            icon={<BoltIcon sx={{ fontSize: 16 }} />}
            label={`${h?.fps ?? '—'} FPS`}
          />
          <Chip size="small" variant="outlined" label={linkLabel(device)} />
          {h?.live && <Chip size="small" color="info" label="live" />}
          <IconButton
            size="small"
            component="a"
            href={webUiUrl(device)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${device.name}'s WLED web interface`}
            title="Open this device's own WLED web interface"
            sx={{ p: 0.5 }}
          >
            <OpenInNewIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Stack>

        {warnings.length > 0 && (
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 1.5, color: md3.warning }}>
            <WarningAmberIcon sx={{ fontSize: 18 }} />
            <Typography variant="caption">
              {warnings.length === 1 ? warnings[0]!.message : `${warnings.length} warnings — open to review`}
            </Typography>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export function DevicesPage() {
  const { data: devices, isLoading, isError, error } = useDevices();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Box>
          <Typography variant="h2">Devices</Typography>
          <Typography variant="body2" color="text.secondary">
            {devices ? `${devices.length} registered` : 'Loading…'}
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
          Add device
        </Button>
      </Stack>

      {isError && (
        <Alert severity="error">Could not load devices: {(error as Error)?.message}</Alert>
      )}

      {isLoading && (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      )}

      {devices && devices.length === 0 && (
        <Card>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <Typography variant="h4" gutterBottom>
              No devices yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Add a WLED controller by IP or hostname. Its info, effects, palettes and DMX
              configuration are read on the spot.
            </Typography>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
              Add your first device
            </Button>
          </CardContent>
        </Card>
      )}

      {devices && devices.length > 0 && (
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
          }}
        >
          {devices.map((d) => (
            <DeviceCard key={d.id} device={d} />
          ))}
        </Box>
      )}

      <AddDeviceDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </Stack>
  );
}
