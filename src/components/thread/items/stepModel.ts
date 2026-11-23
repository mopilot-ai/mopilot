// Turn items projected into narrated steps, summaries, control runs and work blocks.
import { scheduledTaskCall, type ScheduledTaskCall } from '../../../lib/scheduledTaskCall';
import { toolInvocation } from '../../../../shared/toolInvocation.mjs';
import { sessionCallLine, sessionToolCall, type SessionToolCall } from '../../../lib/sessionToolCall';
import { artifactCall, type ArtifactRef } from '../../../lib/designToolCall';
import type { StatusNoteItem, ThreadItem } from '../../../store/types';
import type { CommandAction } from '../../../protocol/v2/CommandAction';
import type { FileUpdateChange } from '../../../protocol/v2/FileUpdateChange';
import { prettyCommand } from '../../../lib/format';
import {
  controlStep,
  controlStepVerb,
  controlThumbnail,
  narrationContexts,
  recoveredFailures,
  type ControlStep,
  type NarrationContext,
} from '../../../lib/agentNarration';
import { withKeys } from '../../../lib/listKeys';
import { foldPhrases, verbPhrases, verbSummary, type VerbPhrase } from '../../../lib/agentNarration/verbs';
import { skillCall } from '../../../session/skillToolCall';
import { formatDuration } from '../../../lib/format';
import { commandWait, toolWait, watchCall, type CommandWait, type WatchCall } from '../../../lib/waitStep';

const NETWORK_RE =
  /^(curl|wget|http|https|ssh|scp|rsync|ping|nc|dig|nslookup)\b|\b(git (clone|fetch|pull|push)|npm (install|i|publish)|pip install|brew install)\b/;

/** A turn item as the thread shows it: a protocol item (Codex's, or one a harness translated) or a status note. */
export type DisplayItem = ThreadItem | StatusNoteItem;
export type ItemOf<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;
export type CommandItem = ItemOf<'commandExecution'>;
export type ToolCallItem = ItemOf<'mcpToolCall'> | ItemOf<'dynamicToolCall'>;
/** Agent activity (a wait, a message, a close; launches render as agent rows) and a progress summary with it. */
export type AgentItem = (ItemOf<'collabAgentToolCall'> | ItemOf<'subAgentActivity'>) & {
  tool?: string;
  kind?: string;
  status?: string;
  prompt?: string | null;
  summary?: string | null;
};
/** The status a running or finished item reports; not every kind has one. */
export type WithStatus = { status?: string | null };

/** Expand an item into display steps (one command may read several files). */
export type Step =
  | { kind: 'read'; item: CommandItem; path: string }
  | { kind: 'search'; item: CommandItem; query: string; path: string | null }
  | { kind: 'list'; item: CommandItem; path: string | null }
  | { kind: 'command'; item: CommandItem; network: boolean; wait?: CommandWait }
  | { kind: 'edit'; item: ItemOf<'fileChange'>; change: FileUpdateChange }
  | { kind: 'web'; item: ItemOf<'webSearch'> }
  | { kind: 'tool'; item: ToolCallItem; control?: ControlStep | null; recovered?: boolean }
  | { kind: 'reasoning'; item: ItemOf<'reasoning'>; thoughts?: ItemOf<'reasoning'>[] }
  | { kind: 'agent'; item: AgentItem }
  // a wait on any harness (a Codex sleep item, a bare `sleep N` command, a sleep tool): a step in its group, never a row of its own
  | { kind: 'wait'; item: DisplayItem; ms: number | null; on?: string }
  // a call that arms a watch to wake the agent later: a monitor, a scheduled check-in
  | ({ kind: 'watch'; item: ToolCallItem } & WatchCall)
  | { kind: 'other'; item: DisplayItem };

export function itemSteps(it: DisplayItem): Step[] {
  it = toolInvocation(it);
  switch (it.type) {
    case 'commandExecution': {
      const acts = it.commandActions ?? [];
      if (acts.length && it.source !== 'userShell' && acts.every((a) => ['read', 'search', 'listFiles'].includes(a.type))) {
        return acts.map(
          (a): Step =>
            a.type === 'read'
              ? { kind: 'read', item: it, path: a.path ?? a.name }
              : a.type === 'search'
                ? { kind: 'search', item: it, query: a.query ?? a.command, path: a.path }
                : { kind: 'list', item: it, path: (a as Extract<CommandAction, { type: 'listFiles' }>).path },
        );
      }
      // a declined command ran nothing: it waited for nothing either
      const wait = it.status === 'declined' ? null : commandWait(it);
      if (wait && !wait.loop && !wait.rest) return [{ kind: 'wait', item: it, ms: wait.ms }];
      // what runs after a leading sleep is the command ("sleep 50 && curl …" goes to the network)
      const run = wait && !wait.loop ? wait.rest : prettyCommand(it.command).trim();
      return [{ kind: 'command', item: it, network: NETWORK_RE.test(run), ...(wait ? { wait } : {}) }];
    }
    case 'fileChange':
      return (it.changes ?? []).map((c): Step => ({ kind: 'edit', item: it, change: c }));
    case 'webSearch':
      return [{ kind: 'web', item: it }];
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const wait = toolWait(it);
      if (wait) return [{ kind: 'wait', item: it, ...wait }];
      const watch = watchCall(it);
      return watch ? [{ kind: 'watch', item: it, ...watch }] : [{ kind: 'tool', item: it }];
    }
    case 'sleep':
      return [{ kind: 'wait', item: it, ms: it.durationMs ?? null }];
    case 'reasoning':
      return [{ kind: 'reasoning', item: it }];
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return [{ kind: 'agent', item: it }];
    default:
      return [{ kind: 'other', item: it }];
  }
}

/** The browser or desktop narration of a tool step: the one its group worked out (with what earlier native programs bound), or its own. */
export function stepControl(s: Step | undefined): ControlStep | null {
  if (s?.kind !== 'tool') return null;
  return s.control !== undefined ? s.control : controlStep(s.item);
}

/** A browser or desktop step that failed: its status, or what Codex's computer use reported. */
function controlFailed(s: Step): boolean {
  // a step Stop cut off reads "Interrupted", not as a failure
  if ((s.item as { cutOff?: boolean }).cutOff === true) return false;
  const status = (s.item as WithStatus).status;
  return status === 'failed' || status === 'declined' || !!stepControl(s)?.problem;
}

/**
 * A group's steps with each tool step's narration worked out in order, so a native program's
 * `app.click()` knows its app, and each failed control step marked `recovered` when a later step of
 * the turn on the same surface succeeded.
 */
export function narrateSteps(steps: Step[], items: DisplayItem[], prior?: NarrationContext): Step[] {
  // each step runs with the bindings of the programs before it (`prior`: what earlier groups and turns bound)
  const contexts = narrationContexts(items, prior);
  const ctxOf = new Map<unknown, NarrationContext>(items.map((item, i) => [item, contexts[i]]));
  const narrated = steps.map((s) => (s.kind === 'tool' ? { ...s, control: controlStep(s.item, ctxOf.get(s.item)) } : s));
  const recovered = recoveredFailures(
    narrated.map((s) => {
      const c = stepControl(s);
      return c && { surface: c.surface, failed: controlFailed(s), finished: (s.item as WithStatus).status !== 'inProgress' };
    }),
  );
  return narrated.map((s, i) => (recovered[i] ? { ...s, recovered: true } : s));
}

/** A failed control step the turn did not get past: the only kind shown as failed. */
export const unrecoveredFailure = (s: Step) => controlFailed(s) && !(s.kind === 'tool' && s.recovered);

/**
 * What a run of control steps did, in Claude Desktop's words: "Clicked, waited, captured page", "Checked tabs 2 times",
 * "…, and 3 more actions, 1 failed" (verbSummary). Only failures the turn did not get past count.
 */
export function controlWords(steps: Step[], inApp: string | null = null): string {
  return verbSummary(controlActions(steps, inApp));
}

/**
 * Each control step's summary words and whether it failed. A step the verb tables don't know keeps its own words; in a
 * run in one app (`inApp`, which the run's row names once) they drop that app, as the run's own rows do (StepRow).
 */
const controlActions = (steps: Step[], inApp: string | null = null) =>
  steps.flatMap((s) => {
    const c = stepControl(s);
    if (!c) return [];
    const verb = controlStepVerb(s.item, c);
    const suffix = ` in ${inApp}`;
    // a step's own words drop the run's one app, which the run's row names once
    const own = verb.unknown && inApp && verb.done.endsWith(suffix);
    const done = own ? verb.done.slice(0, -suffix.length) : verb.done;
    return [{ verb: own ? { ...verb, key: `${c.surface}:other:${done}`, done } : verb, failed: unrecoveredFailure(s) }];
  });

/** Runs of two or more control steps (with any thoughts between them) among a group's steps; other steps stand alone. */
export type StepRun = { kind: 'step'; step: Step } | { kind: 'control'; steps: Step[] };
export function controlRuns(steps: Step[]): StepRun[] {
  const out: StepRun[] = [];
  let run: Step[] = [];
  const flush = () => {
    // thoughts after the run's last control step are not part of it
    let end = run.length;
    while (end && !stepControl(run[end - 1])) end--;
    const body = run.slice(0, end);
    if (body.filter((s) => stepControl(s)).length > 1) out.push({ kind: 'control', steps: body });
    else body.forEach((s) => out.push({ kind: 'step', step: s }));
    run.slice(end).forEach((s) => out.push({ kind: 'step', step: s }));
    run = [];
  };
  for (const s of steps) {
    if (stepControl(s) || (run.length && s.kind === 'reasoning')) run.push(s);
    else {
      flush();
      out.push({ kind: 'step', step: s });
    }
  }
  flush();
  return out;
}

/** The thinking blocks one reasoning row stands for, in order: its own, or the stretch mergeThoughts folded into it. */
export type ThoughtStep = Extract<Step, { kind: 'reasoning' }>;
export const thoughtItems = (s: ThoughtStep) => s.thoughts ?? [s.item];

/**
 * Consecutive thoughts with nothing shown between them as one row, as Claude Desktop shows one "Thought for Ns" per
 * stretch of thinking (its durations summed, its blocks in order in one body): the row keeps the first thought's item,
 * so its key, and an open state, survive the next thought arriving. `rows` are a list's shown rows; `stepOf` reads a
 * row's step (null for a row that is not one) and `withStep` gives the first row of a stretch its merged step.
 */
export function mergeThoughts<T>(rows: T[], stepOf: (row: T) => Step | null, withStep: (row: T, step: Step) => T): T[] {
  const out: T[] = [];
  let prev: ThoughtStep | null = null;
  for (const row of rows) {
    const s = stepOf(row);
    const thought: ThoughtStep | null = s?.kind === 'reasoning' ? s : null;
    if (thought && prev) {
      const merged: ThoughtStep = { ...prev, thoughts: [...thoughtItems(prev), ...thoughtItems(thought)] };
      out[out.length - 1] = withStep(out[out.length - 1], merged);
      prev = merged;
      continue;
    }
    prev = thought;
    out.push(row);
  }
  return out;
}

/** mergeThoughts over a plain list of steps. */
export const mergeThoughtSteps = (steps: Step[]) =>
  mergeThoughts(
    steps,
    (s) => s,
    (_, s) => s,
  );

/** "Edited a file, read 3 files, ran 2 commands, searched the web": counted where Claude Desktop counts them */
export function summarizeSteps(steps: Step[]) {
  const edits = new Set(steps.filter((s) => s.kind === 'edit').map((s) => s.change.path)).size;
  const reads = steps.filter((s) => s.kind === 'read').length;
  const cmds = steps.filter((s) => s.kind === 'command' && !s.network).length;
  const web = steps.filter((s) => s.kind === 'web' || (s.kind === 'command' && s.network)).length;
  const searches = steps.filter((s) => s.kind === 'search' || s.kind === 'list').length;
  // browser and desktop control read as what they did, whichever harness made the calls
  const surfaces = steps.map((s) => stepControl(s)?.surface ?? null);
  const browser = surfaces.filter((x) => x === 'browser').length;
  const desktop = surfaces.filter((x) => x === 'desktop').length;
  // linked-session calls read as what they did with sessions, not as tools; a failed one did nothing with one
  const sessions = steps.map((s) => {
    const line = s.kind === 'tool' ? sessionCallLine(s.item) : null;
    return line && !line.failed ? line.kind : null;
  });
  const starts = new Set(
    steps.flatMap((step) => {
      if (step.kind !== 'tool') return [];
      const line = sessionCallLine(step.item);
      if (!line || line.failed || (line.kind !== 'start' && line.kind !== 'handoff')) return [];
      const session = sessionToolCall(step.item);
      return [
        session?.kind === 'started'
          ? `chat:${session.chatId}`
          : session?.kind === 'proposed' && session.taskId
            ? `proposal:${session.taskId}`
            : step.item,
      ];
    }),
  ).size;
  const proposals = sessions.filter((k) => k === 'offer' || k === 'suggest').length;
  const withdrawn = sessions.filter((k) => k === 'dismiss').length;
  const kept = sessions.filter((k) => k === 'kept').length;
  // a skill reads as the skill it loaded, not as a tool; one that failed to load loaded nothing
  const skills = steps.filter((s) => s.kind === 'tool' && skillCall(s.item)?.state === 'loaded').length;
  const tools =
    steps.filter((s) => s.kind === 'tool').length - browser - desktop - sessions.filter((kind) => kind !== null).length - skills;
  const agents = steps.filter((s) => s.kind === 'agent').length;
  const thoughts = steps.filter((s) => s.kind === 'reasoning').length;
  const waited = stepsWaited(steps);
  const monitors = steps.filter((s) => s.kind === 'watch' && s.what === 'monitor').length;
  const checkins = steps.filter((s) => s.kind === 'watch' && s.what === 'checkin').length;
  // each part is a phrase, so a group with browser or desktop control folds as Claude Desktop's does (foldPhrases)
  const parts: VerbPhrase[] = [];
  let icon: Step['kind'] | null = null;
  const add = (cond: number, text: string, k: Step['kind']) => {
    if (!cond) return;
    parts.push({ key: k, words: text, count: cond, failed: 0, counted: true });
    icon ??= k;
  };
  add(edits, edits === 1 ? 'edited a file' : `edited ${edits} files`, 'edit');
  add(reads, reads === 1 ? 'read a file' : `read ${reads} files`, 'read');
  add(searches, 'searched files', 'search');
  add(cmds, cmds === 1 ? 'ran a command' : `ran ${cmds} commands`, 'command');
  add(web, 'searched the web', 'web');
  // browser and desktop control read as what they did, as a run of them reads ("clicked, typed, captured page")
  if (browser + desktop) {
    parts.push(...verbPhrases(controlActions(steps)));
    icon ??= browser ? 'web' : 'tool';
  }
  add(starts, starts === 1 ? 'started a session' : `started ${starts} sessions`, 'tool');
  add(proposals, proposals === 1 ? 'suggested a task' : `suggested ${proposals} tasks`, 'tool');
  add(withdrawn, withdrawn === 1 ? 'withdrew a suggestion' : `withdrew ${withdrawn} suggestions`, 'tool');
  add(kept, kept === 1 ? 'kept a task here' : `kept ${kept} tasks here`, 'tool');
  add(skills, skills === 1 ? 'loaded a skill' : `loaded ${skills} skills`, 'tool');
  add(tools, tools === 1 ? 'called a tool' : `called ${tools} tools`, 'tool');
  add(agents, 'worked with agents', 'agent');
  add(waited ? 1 : 0, waited?.ms ? `waited ${formatDuration(waited.ms)}` : 'waited', 'wait');
  add(monitors, monitors === 1 ? 'started a monitor' : `started ${monitors} monitors`, 'watch');
  add(checkins, checkins === 1 ? 'scheduled a check-in' : `scheduled ${checkins} check-ins`, 'watch');
  // Claude Desktop's summary of a group with control names no thinking; others keep "thought"
  add(browser + desktop ? 0 : thoughts, 'thought', 'reasoning');
  // a group with control folds past four phrases ("…, and 3 more actions"); others list every part, as before
  const text = browser + desktop ? foldPhrases(parts) : parts.map((p) => p.words).join(', ');
  return { text: text ? text[0].toUpperCase() + text.slice(1) : '', icon: icon ?? 'command' };
}

/**
 * How long a run of steps waited: its wait steps and the leading sleeps of its commands, summed. `ms` is 0 when no wait
 * said how long it was; null when nothing waited.
 */
export function stepsWaited(steps: readonly Step[]): { ms: number } | null {
  const waits = steps.flatMap((s) => (s.kind === 'wait' ? [s.ms] : s.kind === 'command' && s.wait ? [s.wait.ms] : []));
  return waits.length ? { ms: waits.reduce<number>((sum, ms) => sum + (ms ?? 0), 0) } : null;
}

/** What a command runs once its leading sleep is over (the whole command when it has none). */
export const commandAfterWait = (s: Extract<Step, { kind: 'command' }>) =>
  s.wait && !s.wait.loop ? s.wait.rest : prettyCommand(s.item.command).trim();

/**
 * Each step's key: its item's id and its place among that item's steps (a command's reads, a change's files), so
 * a row keeps its open state when the steps around it change.
 */
export function stepKeys(steps: Step[]): Map<Step, string> {
  return new Map(withKeys(steps, (s) => s.item.id).map(({ key, item }) => [item, key]));
}

/**
 * Every screenshot among control steps, oldest first: a collapsed row shows the last ones, as Claude Desktop's tool groups
 * show a run's last captures at the row's end (StepThumbs).
 */
export function controlShots(steps: Step[]): string[] {
  return steps.flatMap((s) => (stepControl(s) ? (controlThumbnail(s.item) ?? []) : []));
}

/** A tool call drawn as a card of its own: what BlockItem draws, and so what buildBlocks keeps out of step groups. */
export type ToolCard =
  | { kind: 'scheduled'; call: ScheduledTaskCall }
  | { kind: 'session'; call: Extract<SessionToolCall, { kind: 'started' }> }
  | { kind: 'artifact'; artifact: ArtifactRef };

/**
 * The card a tool call is, or null: a scheduled-task call that worked, or a session call that started one. A proposal
 * stays a step: the turn's suggestion card ends it. The one answer both routing (isBlockItem) and drawing (BlockItem)
 * read, so a card can't be drawable yet folded into a step group, as session cards once were.
 */
export function toolCard(it: unknown): ToolCard | null {
  const sched = scheduledTaskCall(it);
  if (sched) return { kind: 'scheduled', call: sched };
  const session = sessionToolCall(it);
  if (session?.kind === 'started') return { kind: 'session', call: session };
  const artifact = artifactCall(it);
  return artifact ? { kind: 'artifact', artifact } : null;
}

/** Items that render as standalone blocks rather than steps: a tool call that is a card (toolCard), and these types. */
export function isBlockItem(it: DisplayItem) {
  if (toolCard(it)) return true;
  return [
    'agentMessage',
    'plan',
    'imageView',
    'imageGeneration',
    'contextCompaction',
    'enteredReviewMode',
    'exitedReviewMode',
    'hookPrompt',
    'statusNote',
  ].includes(it.type);
}

/**
 * The publishes a later call in the same items published again: one card per page, at its latest version, and each
 * earlier publish of it a step ("Published Landing page").
 */
export function republished(items: readonly unknown[]): Set<string> {
  const latest = new Map<string, string>();
  const out = new Set<string>();
  for (const it of items) {
    const page = artifactCall(it)?.canonical;
    if (!page) continue;
    const before = latest.get(page);
    if (before) out.add(before);
    latest.set(page, (it as { id: string }).id);
  }
  return out;
}

/** Split a turn's work items into blocks: standalone items and groups of consecutive steps. */
export type WorkBlock = { kind: 'block'; item: DisplayItem } | { kind: 'steps'; items: DisplayItem[] };
export function buildBlocks(items: ThreadItem[], superseded: ReadonlySet<string> = republished(items)): WorkBlock[] {
  const out: WorkBlock[] = [];
  for (const it of items as DisplayItem[]) {
    if (it.type === 'userMessage' || it.type === 'functionCallOutput') continue;
    if (isBlockItem(it) && !superseded.has(it.id)) out.push({ kind: 'block', item: it });
    else {
      const last = out[out.length - 1];
      if (last?.kind === 'steps') last.items.push(it);
      else out.push({ kind: 'steps', items: [it] });
    }
  }
  return out;
}
