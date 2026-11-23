// Types for shared/modelLabels.mjs: how a model and a reasoning effort are named.
export function modelLabel(displayName: string | null | undefined): string;
export const EFFORT_LABELS: Record<string, string>;
export function effortLabel(e: string | null | undefined): string;
