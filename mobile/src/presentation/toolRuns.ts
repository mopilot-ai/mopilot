// Folds a turn's consecutive tool steps into runs with a one-line summary ("Read 3 files"), and times the turn line ("Working for 1m 3s").
import type { Data, Row } from './thread';

/** The closed set of things a step can be; anything else is `other`, which reads as the generic "N steps". */
export type Kind = 'read' | 'search' | 'edit' | 'run' | 'web' | 'other';
const KINDS: readonly Kind[] = ['read', 'search', 'edit', 'run', 'web', 'other'];
export type KeyedRow = Row & { key: string };
/** One block of the transcript: a row as it is, or two or more consecutive steps folded into a run. */
export type Block = { type: 'row'; row: KeyedRow } | { type: 'run'; key: string; steps: KeyedRow[]; summary: string; running: boolean };

/** Per kind: what the run did, and what is counted (singular, plural). Past tense even while the step runs, as Claude's row says it ("Searched the web"). */
const WORDS: Record<Exclude<Kind, 'other'>, [string, string, string]> = {
  read: ['Read', 'file', 'files'],
  search: ['Searched', 'time', 'times'],
  edit: ['Made', 'edit', 'edits'],
  run: ['Ran', 'command', 'commands'],
  web: ['Searched the web', 'time', 'times'],
};
const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** More kinds than this in one run read as the generic fallback instead of a list. */
const MOST_KINDS = 2;

const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The kind of a live thread item, from its type and (for commands) what the harness says the command did. */
export function kindOfItem(item: Data): Kind {
  if (item.type === 'fileChange') return 'edit';
  if (item.type === 'webSearch') return 'web';
  if (item.type !== 'commandExecution') return 'other';
  const first = Array.isArray(item.commandActions) ? (item.commandActions[0] as Data | undefined)?.type : undefined;
  return first === 'read' || first === 'listFiles' ? 'read' : first === 'search' ? 'search' : 'run';
}

/** The kind of a saved step row, which is only a line of text ("Ran npm test", "Edited a.ts", "Searched for x"). */
export function kindOfText(text: string): Kind {
  if (/^(?:Ran )?(?:Read|LS) (?!the page)/.test(text)) return 'read';
  if (/^(?:Ran )?(?:Grep|Glob) /.test(text)) return 'search';
  if (/^(?:Edited|Created) /.test(text)) return 'edit';
  if (/^Searched (?:for |the web)/.test(text)) return 'web';
  return /^Ran /.test(text) ? 'run' : 'other';
}

/** A step row's kind and duration: what the row already carries, else what its item or text says. */
export function stepFacts(item: Data, text: string, live: boolean): { kind: Kind; ms: number | null } {
  if (live) return { kind: kindOfItem(item), ms: ms(item.durationMs) };
  return { kind: isKind(item.kind) ? item.kind : kindOfText(text), ms: ms(item.ms) };
}

/** "2 s", "1m 3s", "1h 2m"; null under a second, where a time says nothing. */
export function duration(milliseconds: number): string | null {
  const total = Math.floor(milliseconds / 1000);
  if (total < 1) return null;
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

/** One line for a run of steps, in the past tense whether or not it still runs ("Read 3 files"); a run of mixed kinds beyond the closed set reads "5 steps", as Claude's row counts them. */
export function summarize(steps: Row[]): string {
  const counts = new Map<Kind, number>();
  for (const s of steps) counts.set(s.kind ?? 'other', (counts.get(s.kind ?? 'other') ?? 0) + 1);
  const named = [...counts].filter(([kind]) => kind !== 'other');
  if (counts.has('other') || named.length > MOST_KINDS) return `${steps.length} ${noun(steps.length, 'step', 'steps')}`;
  return named
    .map(([kind, n], i) => {
      const [done, one, many] = WORDS[kind as Exclude<Kind, 'other'>];
      // a single web search is "Searched the web"; the rest count what they did
      const phrase = kind === 'web' && n === 1 ? done : `${done} ${n} ${noun(n, one, many)}`;
      return i === 0 ? phrase : phrase[0].toLowerCase() + phrase.slice(1);
    })
    .join(', ');
}

export const isStep = (row: Row) => row.role === 'step' || row.role === 'live';
const isYou = (row: Row) => row.role === 'user' || row.role === 'liveUser';

/**
 * The transcript as blocks: two or more consecutive steps become one run, and the steps of the last turn (everything
 * after your last message) are left out when `foldedTurn` is that turn's key, the key of your last message. `activity`
 * counts that turn's steps, to tell whether there is anything to fold. A run is live when it ends the transcript while the turn runs.
 */
/** The blocks already made, so a commit that did not change a row or a run hands the same block object on: a lone row names its block, a run's first step names the run. */
const rowBlocks = new WeakMap<KeyedRow, Extract<Block, { type: 'row' }>>();
const runBlocks = new WeakMap<KeyedRow, Extract<Block, { type: 'run' }>>();
function rowBlock(row: KeyedRow): Block {
  let block = rowBlocks.get(row);
  if (!block) rowBlocks.set(row, (block = { type: 'row', row }));
  return block;
}
function runBlock(steps: KeyedRow[], running: boolean): Block {
  const known = runBlocks.get(steps[0]);
  if (known && known.running === running && known.steps.length === steps.length && known.steps.every((step, i) => step === steps[i]))
    return known;
  const block = { type: 'run' as const, key: steps[0].key, steps, summary: summarize(steps), running };
  runBlocks.set(steps[0], block);
  return block;
}

export function fold(
  rows: KeyedRow[],
  opts: { running: boolean; foldedTurn: string | null },
): { blocks: Block[]; activity: number; turnKey: string } {
  let turn = 0;
  let turnKey = '';
  rows.forEach((row, i) => {
    if (isYou(row)) {
      turn = i + 1;
      turnKey = row.key;
    }
  });
  // a turn that runs again (an answered request, a continued turn) shows its steps as they come
  const folded = !opts.running && opts.foldedTurn === turnKey;
  const blocks: Block[] = [];
  let activity = 0;
  for (let i = 0; i < rows.length; ) {
    if (!isStep(rows[i])) {
      blocks.push(rowBlock(rows[i++]));
      continue;
    }
    let end = i;
    while (end < rows.length && isStep(rows[end])) end++;
    const steps = rows.slice(i, end);
    const last = i >= turn;
    if (last) activity += steps.length;
    if (!(last && folded)) {
      if (steps.length === 1) blocks.push(rowBlock(steps[0]));
      else blocks.push(runBlock(steps, opts.running && end === rows.length));
    }
    i = end;
  }
  return { blocks, activity, turnKey };
}

/** Where the turn clock stands: when the phone saw the turn start, and how long it took once it saw it end; null where it did not see that. */
export type Clock = { active: boolean; start: number | null; took: number | null; ended: boolean } | null;

/**
 * The clock after a turn status is seen. A turn already running when the chat was opened has no known start, and says
 * "Working…" rather than a time the phone did not measure.
 */
export function tick(clock: Clock, status: unknown, now: number): Clock {
  const active = status === 'running' || status === 'inProgress' || status === 'awaitingUser';
  if (clock === null) return { active, start: null, took: null, ended: false };
  if (active === clock.active) return clock;
  // `ended`: the phone saw the turn finish, whether or not it saw it start (so it has no time to give)
  return active
    ? { active, start: now, took: null, ended: false }
    : { active, start: clock.start, took: clock.start === null ? null : now - clock.start, ended: true };
}
