// Shared fixtures for MoMo's notes tests: a fixed clock, id counter, owner and mail sources, op and line builders.
import type { OpsContext, SourceText } from '../../../shared/momoCore/noteOps.ts';
import type { Line, NotesTree } from '../../../shared/momoCore/notes.ts';

export const NOW = '2026-11-22T10:00:00.000Z';
export const counter = () => {
  let n = 0;
  return () => `id${++n}`;
};
export const owner = (id: string, text: string): SourceText => ({ id, kind: 'chat', at: NOW, text, owner: true });
export const mail = (id: string, text: string): SourceText => ({ id, kind: 'mail', at: NOW, text, owner: false });
export const ctx = (sources: SourceText[], extra: Partial<OpsContext> = {}): OpsContext => ({
  sources,
  trigger: 'chat',
  tainted: false,
  now: NOW,
  newId: counter(),
  ...extra,
});
export const add = (over: Record<string, unknown> = {}) => ({
  type: 'add',
  title: 'Dana',
  kind: 'person',
  text: 'Prefers email to calls',
  sourceId: 'm1',
  quote: 'I prefer email',
  ...over,
});

export function oneLine(tree: NotesTree) {
  return tree.notes[0].lines[0];
}
export const lineOf = (over: Partial<Line> = {}): Line => ({
  id: 'l1',
  text: 'Lives in Berlin',
  origin: 'mail',
  sources: [{ sourceId: 's1', kind: 'mail', at: NOW }],
  quote: 'Berlin',
  updated: NOW,
  ...over,
});
export const treeOf = (...lines: Line[]): NotesTree => ({
  notes: [{ id: 'n1', title: 'Dana', kind: 'person', updated: NOW, lines }],
  archive: [],
});
