/**
 * Material Design 3 colour roles for Extended WLED Controller.
 *
 * Dark-only (project requirement). Per the spec's UI notes: "professional and
 * sleek … mostly dark tinted colors. More black/grey tints as background colors,
 * for accent colors the color yellow from the logo". So the neutrals are a true
 * greyscale (no hue tint) and the single accent is the logo yellow #FDB003.
 *
 * NOTE: these tokens are for UI chrome only. Colours that represent WLED state —
 * effect previews, colour pickers, status dots — are chosen for meaning, not
 * from this palette.
 */
export const md3 = {
  // Accent — the Frankvandetechniek logo yellow (#FDB003).
  primary: '#FDB003',
  onPrimary: '#231A00',
  primaryContainer: '#463500',
  onPrimaryContainer: '#FFDF9C',

  // Secondary / tertiary kept neutral-warm-grey so the yellow stays the only
  // real accent.
  secondary: '#D6D6D6',
  onSecondary: '#2E2E2E',
  secondaryContainer: '#3A3A3A',
  onSecondaryContainer: '#EDEDED',

  tertiary: '#C9C9C9',
  onTertiary: '#2B2B2B',
  tertiaryContainer: '#363636',
  onTertiaryContainer: '#E8E8E8',

  // Semantic status colours — intentionally NOT the accent, so a warning never
  // reads as a call-to-action.
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
  success: '#7ED993',
  warning: '#FFC65C',

  // Neutrals — pure greyscale, near-black background.
  background: '#101010',
  onBackground: '#E5E5E5',
  surface: '#101010',
  onSurface: '#E5E5E5',
  surfaceVariant: '#3C3C3C',
  onSurfaceVariant: '#C4C4C4',

  outline: '#8A8A8A',
  outlineVariant: '#333333',

  surfaceDim: '#101010',
  surfaceBright: '#3A3A3A',
  surfaceContainerLowest: '#0A0A0A',
  surfaceContainerLow: '#181818',
  surfaceContainer: '#1C1C1C',
  surfaceContainerHigh: '#262626',
  surfaceContainerHighest: '#303030',

  inverseSurface: '#E5E5E5',
  inverseOnSurface: '#2E2E2E',
  scrim: '#000000',
} as const;

export type Md3Role = keyof typeof md3;

/** MD3 state-layer opacities. */
export const stateLayer = {
  hover: 0.08,
  focus: 0.12,
  pressed: 0.12,
  dragged: 0.16,
} as const;

/** MD3 shape scale (px). */
export const shape = {
  none: 0,
  extraSmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 28,
  full: 9999,
} as const;
