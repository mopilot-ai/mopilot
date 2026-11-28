// Typed Auto routing vocabulary shared by main's router service and the window's model and harness pickers.
export type AutoMode = 'harness' | 'global';
export type AutoTier = 'C0' | 'C1' | 'C2' | 'C3';
export type CostTier = 'low' | 'medium' | 'high';
/** One ACP agent's record of what an Auto turn changed: the chat's own value and Auto's, and the turn that wrote it. */
export type AutoRestore = { generation: number; model?: { own: string; applied: string }; effort?: { own: string; applied: string } };
export const AUTO_MODES: readonly AutoMode[];
export const AUTO_MODEL_ID: '@auto';
export const AUTO_HARNESS_ID: '@auto';
export const TIERS: readonly AutoTier[];
export const EFFORT_SCALE: readonly string[];
export const COST_WEIGHT: Readonly<Record<CostTier, number>>;
export function autoModeOf(config: { autoRoute?: unknown } | null | undefined): AutoMode | null;
export function costTierOf(prefs: { autoRouteCost?: unknown } | null | undefined): CostTier;
export function effortFor(thinking: string, offered: readonly string[] | null | undefined): string | null;
export function sizeClass(id: string): number;
export function versionOf(id: string): number[];
export function compareVersions(a: number[], b: number[]): number;
export type LadderModel = string | { id: string; resolved?: string | null };
export function modelLadder(models: readonly LadderModel[] | null | undefined): string[];
export function tierModels(
  models: readonly LadderModel[] | null | undefined,
  override?: Partial<Record<string, string>> | null,
): Record<AutoTier, string> | null;
