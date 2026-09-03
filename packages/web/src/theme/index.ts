import { createTheme, alpha, type Theme } from '@mui/material/styles';
import { md3, shape } from './tokens.js';

declare module '@mui/material/styles' {
  interface Palette {
    md3: typeof md3;
  }
  interface PaletteOptions {
    md3?: typeof md3;
  }
}

export function createAppTheme(): Theme {
  return createTheme({
    palette: {
      mode: 'dark',
      md3,
      primary: { main: md3.primary, contrastText: md3.onPrimary },
      secondary: { main: md3.secondary, contrastText: md3.onSecondary },
      error: { main: md3.error, contrastText: md3.onError },
      warning: { main: md3.warning, contrastText: '#231A00' },
      success: { main: md3.success, contrastText: '#00390F' },
      info: { main: '#8FB7D9', contrastText: '#0A1E2E' },
      background: { default: md3.background, paper: md3.surfaceContainer },
      text: {
        primary: md3.onSurface,
        secondary: md3.onSurfaceVariant,
        disabled: alpha(md3.onSurface, 0.38),
      },
      divider: md3.outlineVariant,
    },
    shape: { borderRadius: shape.medium },
    typography: {
      fontFamily:
        "'Roboto Flex Variable', 'Roboto Flex', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      h1: { fontSize: '2.25rem', fontWeight: 500, letterSpacing: '-0.015em' },
      h2: { fontSize: '1.75rem', fontWeight: 500, letterSpacing: '-0.01em' },
      h3: { fontSize: '1.375rem', fontWeight: 500 },
      h4: { fontSize: '1.125rem', fontWeight: 600 },
      h5: { fontSize: '1rem', fontWeight: 600 },
      h6: { fontSize: '0.875rem', fontWeight: 600, letterSpacing: '0.02em' },
      subtitle2: { fontWeight: 600, letterSpacing: '0.02em' },
      button: { textTransform: 'none', fontWeight: 600, letterSpacing: '0.01em' },
      overline: { letterSpacing: '0.12em', fontWeight: 600 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': { colorScheme: 'dark' },
          body: { backgroundColor: md3.background, color: md3.onSurface },
          '*::-webkit-scrollbar': { width: 10, height: 10 },
          '*::-webkit-scrollbar-thumb': {
            backgroundColor: alpha(md3.onSurfaceVariant, 0.3),
            borderRadius: 8,
          },
          '*::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          outlined: { borderColor: md3.outlineVariant },
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            backgroundColor: md3.surfaceContainerLow,
            border: `1px solid ${md3.outlineVariant}`,
            borderRadius: shape.large,
          },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0, color: 'transparent' },
        styleOverrides: {
          root: {
            backgroundColor: md3.surface,
            borderBottom: `1px solid ${md3.outlineVariant}`,
            backgroundImage: 'none',
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: shape.full, paddingInline: 20 },
          contained: { backgroundColor: md3.primary, color: md3.onPrimary },
          outlined: { borderColor: md3.outline },
          textPrimary: { color: md3.primary },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: shape.small, fontWeight: 600 },
          outlined: { borderColor: md3.outlineVariant },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: md3.inverseSurface,
            color: md3.inverseOnSurface,
            fontSize: '0.75rem',
          },
        },
      },
      MuiSlider: {
        styleOverrides: {
          rail: { opacity: 0.3 },
          thumb: {
            '&:hover, &.Mui-focusVisible': {
              boxShadow: `0 0 0 8px ${alpha(md3.primary, 0.16)}`,
            },
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundColor: md3.surfaceContainerHigh,
            borderRadius: shape.extraLarge,
            backgroundImage: 'none',
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          notchedOutline: { borderColor: md3.outline },
          root: { borderRadius: shape.small },
        },
      },
    },
  });
}
