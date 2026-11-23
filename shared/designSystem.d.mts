// Types for shared/designSystem.mjs: a project's design systems and designs kept as files.
export const DEFAULT_SYSTEMS_DIR: string;
export const DEFAULT_DESIGNS_DIR: string;
export const MANIFEST: string;
export const DESIGN_INDEX: string;
export const LIMITS: Readonly<{ readme: number; file: number; tokens: number; files: number; depth: number }>;
export const TEXT_EXTS: readonly string[];

export interface Viewport {
  width: number;
  height: number | null;
}
export interface DsCard {
  group: string;
  name: string | null;
  viewport: Viewport | null;
}
export interface ManifestCard {
  path: string;
  group: string;
  name: string;
  viewport?: Viewport;
}
export interface Manifest {
  v: 1;
  cards: ManifestCard[];
}
export interface Token {
  name: string;
  value: string;
  type: string | null;
}
export interface TokenSummary {
  colors: { name: string; value: string }[];
  fonts: { name: string; value: string }[];
  sizes: { name: string; value: string }[];
  other: number;
  total: number;
}

export function parseDsCard(text: string): DsCard | null;
export function naturalCompare(a: string, b: string): number;
export function compileManifest(cards: { path: string; group: string; name?: string | null; viewport?: Viewport | null }[]): Manifest;
export function nameFromPath(p: string): string;
export function readmeTitle(text: string): string | null;
export function slugOf(name: string): string;
export function flattenTokens(json: unknown): Token[];
export function summarizeTokens(json: unknown): TokenSummary;
export function checkDesignIndex(json: unknown): string[];
export function isRelativeInside(p: unknown): boolean;
