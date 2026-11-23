// The shapes MoMo's page reads (momo.prefs.get, momo.memory.changes and past, the brain with its effort, a routine's schedule parts), each checked before the page shows it.
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const unreadable = (what: string) => new Error(`Could not read ${what}.`);

export type QuietHours = { start: string; end: string } | null;
export type Prefs = { paused: boolean; proactivity: string; quietHours: QuietHours; levels: string[] };
/** Who made a memory change: you, MoMo's own pass, or a MoMo chat. */
export type ChangeBy = 'You' | 'MoMo' | 'A chat';
export type Change = { id: string; verb: string; lines: string[]; by: ChangeBy; at: number; undoable: boolean; undone: boolean };
export type PastFact = { id: string; text: string };
/** The brain as the Mac keeps it; `effort` only where the Mac reports one. */
export type BrainChoice = {
  harness: string;
  account: string | null;
  model: string | null;
  modelLabel: string | null;
  effort: string | null;
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `momo.prefs.get` and `momo.prefs.set`'s answer. */
export function parsePrefs(value: unknown): Prefs {
  const v = record(value);
  if (!v || typeof v.paused !== 'boolean' || !text(v.proactivity)) throw unreadable('MoMo’s settings');
  const q = record(v.quietHours);
  const quietHours = q && CLOCK.test(String(q.start)) && CLOCK.test(String(q.end)) ? { start: String(q.start), end: String(q.end) } : null;
  const levels = Array.isArray(v.levels) ? v.levels.flatMap((l) => (text(record(l)?.id) ? [String(record(l)!.id)] : [])) : [];
  return { paused: v.paused, proactivity: v.proactivity as string, quietHours, levels };
}

/** How each proactivity level reads; one the Mac adds later shows by its own id. */
export const LEVEL_LABEL: Record<string, string> = { off: 'Off', low: 'Low', default: 'Default', high: 'High' };
export const levelLabel = (id: string) => LEVEL_LABEL[id] ?? id;

const EFFORT: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
/** An effort level as the Mac's menus name it; one added later shows by its own id. */
export const effortLabel = (id: string | null) => (id === null ? 'Default' : (EFFORT[id] ?? id));

const VERB: Record<string, string> = { save: 'Added', update: 'Edited', forget: 'Deleted', pass: 'Updated', undo: 'Undid a change' };

/** One fact's part in a change in a few words, as the Mac's Memory tab writes it. */
export function itemLine(item: unknown): string | null {
  const i = record(item);
  const before = record(i?.before);
  const after = record(i?.after);
  if (!before && !after) return null;
  if (!before) return `+ ${text(after?.text) ?? ''}`;
  if (!after) return `− ${text(before.text) ?? ''}`;
  if (after.invalidAt !== undefined && before.invalidAt === undefined) return `Replaced: ${text(before.text) ?? ''}`;
  return before.text === after.text ? String(after.text ?? '') : `${String(before.text ?? '')} → ${String(after.text ?? '')}`;
}

/** `momo.memory.changes`: the newest first, each saying whether Undo can still take it back. */
export function parseChanges(value: unknown): Change[] {
  const v = record(value);
  if (!v || !Array.isArray(v.changes)) throw unreadable('what MoMo learned');
  return v.changes.flatMap((c) => {
    const r = record(c);
    const id = text(r?.id);
    if (!r || !id || typeof r.at !== 'number') return [];
    const by: ChangeBy = r.by === 'user' ? 'You' : r.by === 'pass' ? 'MoMo' : 'A chat';
    const lines = Array.isArray(r.items) ? r.items.flatMap((i) => itemLine(i) ?? []) : [];
    return [
      { id, verb: VERB[String(r.op)] ?? 'Changed', lines, by, at: r.at, undoable: r.undoable === true, undone: r.undone !== undefined },
    ];
  });
}

/** `momo.memory.past`: facts a newer one replaced. */
export function parsePast(value: unknown): PastFact[] {
  const v = record(value);
  if (!v || !Array.isArray(v.facts)) throw unreadable('MoMo’s past memories');
  return v.facts.flatMap((f) => {
    const r = record(f);
    return text(r?.id) && text(r?.text) ? [{ id: String(r!.id), text: String(r!.text) }] : [];
  });
}

/** The brain by the name the user knows: its model's label, else the model, else the agent. */
export const brainName = (b: BrainChoice) => b.modelLabel ?? b.model ?? b.harness;

/** `momo.brain.get` as the brain the Mac keeps, or null when none is chosen. */
export function parseBrainChoice(value: unknown): BrainChoice | null {
  const b = record(record(value)?.brain);
  const harness = text(b?.harness);
  if (!b || !harness) return null;
  return { harness, account: text(b.account), model: text(b.model), modelLabel: text(b.modelLabel), effort: text(b.effort) };
}
