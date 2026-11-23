// Types for shared/modelFraming.mjs.
export const MODEL_MARK: RegExp;
export function markedText(label: string, text: string): string;
export function routineReportText(name: string, completed: boolean, text: string): string;
export function internalReply(text: unknown): { kind: 'hidden' } | null;
export function markedCard(
  text: unknown,
): { kind: 'routine'; name: string; completed: boolean; title: string; body: string } | { kind: 'marked'; title: string; body: '' } | null;
