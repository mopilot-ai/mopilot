// Types for the app's default palette per mode.
export interface DefaultPalette {
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
  /** the color of toggles and focus rings, apart from the brand accent */
  readonly interactive: string;
  readonly selection: string;
}
export const DEFAULT_PALETTE: Readonly<{ dark: DefaultPalette; light: DefaultPalette }>;
export function defaultPalette(dark: boolean): DefaultPalette;
