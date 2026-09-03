import '@fontsource-variable/roboto-flex';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter, Navigate } from 'react-router-dom';
import { createAppTheme } from './theme/index.js';
import { AppShell } from './AppShell.js';
import { DevicesPage } from './pages/DevicesPage.js';
import { DeviceControlPage } from './pages/DeviceControlPage.js';
import { StagePage } from './pages/StagePage.js';
import { LayoutPage } from './pages/LayoutPage.js';
import { StudioPage } from './pages/StudioPage.js';
import { PaintPage } from './pages/PaintPage.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/devices" replace /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'devices/:id', element: <DeviceControlPage /> },
      { path: 'layout', element: <LayoutPage /> },
      { path: 'studio', element: <StudioPage /> },
      { path: 'paint', element: <PaintPage /> },
      { path: 'stage', element: <StagePage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={createAppTheme()}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
