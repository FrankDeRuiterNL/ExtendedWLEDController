import { Box, Tooltip } from '@mui/material';
import type { DeviceConnectionStatus } from '@ewc/core';
import { md3 } from '../theme/tokens.js';

const MAP: Record<DeviceConnectionStatus, { color: string; label: string }> = {
  live: { color: md3.success, label: 'Live — realtime WebSocket connected' },
  polling: { color: md3.success, label: 'Online — HTTP polling (no WebSocket on this build)' },
  connecting: { color: md3.warning, label: 'Connecting…' },
  offline: { color: md3.error, label: 'Offline — device unreachable, retrying' },
};

export function StatusDot({ connection }: { connection: DeviceConnectionStatus }) {
  const { color, label } = MAP[connection] ?? MAP.offline;
  const solid = connection === 'live' || connection === 'polling';
  return (
    <Tooltip title={label}>
      <Box
        sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          bgcolor: color,
          boxShadow: solid ? `0 0 0 3px ${color}22` : 'none',
          flexShrink: 0,
        }}
      />
    </Tooltip>
  );
}
