// MoPilot's default slate-and-blue palette per mode: the one copy the
// renderer's surfaces, the terminal and code themes and the main process's window colors all read.

/**
 * MoPilot's slate canvases and blue accents. Surfaces are derived from this small palette.
 * @typedef {{ bg: string, fg: string, accent: string, interactive: string, selection: string }} DefaultPalette
 */

/** @type {Readonly<{ dark: Readonly<DefaultPalette>, light: Readonly<DefaultPalette> }>} */
export const DEFAULT_PALETTE = Object.freeze({
  dark: Object.freeze({ bg: '#171a21', fg: '#eef1f6', accent: '#3b6ff5', interactive: '#2667de', selection: '#283c65' }),
  light: Object.freeze({ bg: '#fbfcfe', fg: '#181e2a', accent: '#3b6ff5', interactive: '#2667de', selection: '#dbe7ff' }),
});

/** The palette for a mode. @param {boolean} dark @returns {Readonly<DefaultPalette>} */
export function defaultPalette(dark) {
  return dark ? DEFAULT_PALETTE.dark : DEFAULT_PALETTE.light;
}
