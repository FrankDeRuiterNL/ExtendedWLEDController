import { AppBar, Box, Button, Container, Link as MuiLink, Stack, Toolbar, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink, NavLink, Outlet } from 'react-router-dom';
import { APP_VERSION } from '@ewc/core';
import { useRealtimeStream } from './api/realtime.js';
import { md3 } from './theme/tokens.js';

function LiveIndicator() {
  const status = useRealtimeStream();
  const map = {
    open: { color: md3.success, label: 'Live — realtime updates connected' },
    connecting: { color: md3.warning, label: 'Connecting to realtime updates…' },
    closed: { color: md3.error, label: 'Realtime updates disconnected — retrying' },
  } as const;
  const { color, label } = map[status];
  return (
    <Tooltip title={label}>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color }} />
        <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>
          {status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

function Footer() {
  return (
    <Box
      component="footer"
      sx={{
        mt: 'auto',
        borderTop: `1px solid ${md3.outlineVariant}`,
        bgcolor: md3.surfaceContainerLowest,
        py: 2.5,
      }}
    >
      <Container maxWidth="lg">
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems="center"
          justifyContent="space-between"
        >
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box
              component="img"
              src="/fvdt-logo-dark.png"
              alt="Frankvandetechniek"
              sx={{ height: 26, width: 'auto', display: 'block', borderRadius: 0.5 }}
            />
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.75em' }}>
              by{' '}
              <MuiLink href="https://frankvandetechniek.nl" target="_blank" rel="noreferrer" color="primary">
                Frankvandetechniek.nl
              </MuiLink>
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Extended WLED Controller · v{APP_VERSION}
          </Typography>
        </Stack>
      </Container>
    </Box>
  );
}

export function AppShell() {
  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <AppBar position="sticky">
        <Container maxWidth="lg" disableGutters>
          <Toolbar sx={{ gap: 1.5 }}>
            <Box
              component="img"
              src="/logo-ewc.svg"
              alt="Extended WLED Controller"
              sx={{ width: 34, height: 34, display: 'block' }}
            />
            <MuiLink
              component={RouterLink}
              to="/devices"
              underline="none"
              color="text.primary"
              sx={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}
            >
              <Typography variant="h5" component="span">
                Extended WLED Controller
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Multi-device control &amp; effects
              </Typography>
            </MuiLink>
            <Box sx={{ flex: 1 }} />
            <Stack direction="row" spacing={0.5} sx={{ mr: 1, display: { xs: 'none', sm: 'flex' } }}>
              {[
                { to: '/devices', label: 'Devices' },
                { to: '/layout', label: 'Layout' },
                { to: '/hardware', label: 'Hardware' },
                { to: '/studio', label: 'Scenes' },
                { to: '/paint', label: 'Paint' },
                { to: '/stage', label: 'System' },
              ].map((n) => (
                <Button
                  key={n.to}
                  component={NavLink}
                  to={n.to}
                  size="small"
                  sx={{
                    color: 'text.secondary',
                    '&.active': { color: 'primary.main', bgcolor: `${md3.primary}14` },
                  }}
                >
                  {n.label}
                </Button>
              ))}
            </Stack>
            <LiveIndicator />
          </Toolbar>
        </Container>
      </AppBar>

      <Container maxWidth="lg" sx={{ flex: 1, py: { xs: 2, sm: 4 } }}>
        <Outlet />
      </Container>

      <Footer />
    </Box>
  );
}
