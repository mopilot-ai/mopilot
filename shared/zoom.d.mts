// Types for the app zoom model shared by main (electron/app/zoom.cjs) and windows.
export const ZOOM_STEP: 0.5;
export const MIN_ZOOM_LEVEL: -3.5;
export const MAX_ZOOM_LEVEL: 6;
export const CHAT_FONT_SIZES: number[];
export function zoomFactorOf(level: number): number;
export function normalizeZoomLevel(level: unknown): number;
export function zoomStep(level: unknown, direction: number): number;
export function legacyZoomPatch(prefs: unknown): { zoomLevel: number; fontSize: number } | null;
export function zoomLevelOf(prefs: unknown): number;
export function windowButtonsAt(at: { x: number; y: number }, factor: number): { x: number; y: number };
export function titleBarHeightAt(height: number, factor: number): number;
