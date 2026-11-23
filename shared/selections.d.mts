import type { DiffCommentRange } from './diffComments.mjs';
export type SelectedContext = string | { text?: string; annotation?: string; annotationId?: string; diff?: DiffCommentRange };
export function withSelections(prompt: string, selections: SelectedContext[]): string;
