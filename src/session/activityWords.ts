// Claude Code's words for its built-in tools on the activity line, and which of its working-mark animations a running
// step plays. Every harness's steps read and move the same way; activityUx.ts words the other steps.
import type { ActivityLabel } from './activityUx';

/** What the mark shows: one of Claude's activity animations. */
export type MarkActivity = 'think' | 'search' | 'read' | 'code' | 'write' | 'default' | 'blocked';

/** A step as the activity line sees it (stepModel's Step, loosely). */
export interface ActivityStep {
  kind: string;
  item: unknown;
  change?: unknown;
}

type Loose = Record<string, unknown> | null | undefined;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** "Verb meta", or the verb alone when there is no meta. */
const verbed = (verb: string, meta: string | undefined): ActivityLabel => (meta ? { verb, meta } : { verb });

/** Claude Code's running words for the built-in tools a harness reports as plain tool calls. */
export function builtInWords(name: string, args: Loose): ActivityLabel | undefined {
  switch (name) {
    case 'Skill':
      return verbed('Running skill', text(args?.skill) && `/${text(args?.skill)}`);
    case 'TaskCreate':
      return verbed('Adding task', text(args?.subject));
    case 'TaskUpdate':
      return verbed('Updating task', text(args?.subject));
    case 'TaskGet':
      return { verb: 'Reading task' };
    case 'TaskList':
      return { verb: 'Listing tasks' };
    case 'TaskStop':
      return { verb: 'Stopping task' };
    case 'TodoWrite':
      return { verb: 'Updating todos' };
    case 'EnterPlanMode':
      return { verb: 'Making a plan' };
    case 'ExitPlanMode':
      return { verb: 'Proposing plan' };
    case 'EnterWorktree':
      return { verb: typeof args?.path === 'string' ? 'Entering a worktree' : 'Creating a worktree' };
    case 'ExitWorktree':
      return { verb: 'Leaving the worktree' };
    case 'SendUserMessage':
    case 'SendUserFile':
      return { verb: 'Sending' };
    case 'ListAgents':
    case 'ListPeers':
      return { verb: 'Listing agents' };
    case 'AskUserQuestion':
      return { verb: 'Asking' };
    case 'ScheduleWakeup':
      return { verb: args?.stop === true ? 'Stopping loop' : 'Scheduling check-in' };
    default:
      return undefined;
  }
}

const READ_WORDS = new Set(['read', 'view', 'get', 'list', 'fetch', 'search', 'find', 'query', 'retrieve', 'lookup', 'load', 'open', 'ls']);
const WRITE_WORDS = new Set([
  'write',
  'edit',
  'create',
  'update',
  'delete',
  'remove',
  'append',
  'insert',
  'replace',
  'patch',
  'send',
  'post',
  'add',
  'save',
  'upload',
  'comment',
  'artifacts',
]);
const CODE_WORDS = new Set(['bash', 'exec', 'execute', 'run', 'shell', 'python', 'repl', 'script', 'eval', 'javascript']);
const SEARCH_TOOLS = new Set(['image_search', 'launch_extended_search_task']);

/** A description's first word and the base forms it may stand for ("Reading" → read, "Lists" → list). */
function leadForms(description: string): string[] {
  const word = /^\s*([A-Za-z]+)/.exec(description)?.[1]?.toLowerCase();
  if (word === undefined) return [];
  if (word.endsWith('ing') && word.length > 5) {
    const stem = word.slice(0, -3);
    return [word, stem, `${stem}e`, stem.replace(/([b-df-hj-np-tv-z])\1$/, '$1')];
  }
  if (word.endsWith('ies')) return [word, `${word.slice(0, -3)}y`];
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return [word, word.slice(0, -1), word.slice(0, -2)];
  return [word];
}

/** The mark for a command: a described write or read, else code. */
function commandActivity(description: string | undefined): MarkActivity {
  for (const form of description ? leadForms(description) : []) {
    if (WRITE_WORDS.has(form)) return 'write';
    if (READ_WORDS.has(form)) return 'read';
  }
  return 'code';
}

/** The mark for a tool known only by name: its words say whether it searches, reads, writes or runs code. */
function toolActivity(name: string): MarkActivity {
  const lower = name.toLowerCase();
  if (SEARCH_TOOLS.has(lower)) return 'search';
  if (lower === 'todowrite') return 'write';
  if (lower.startsWith('memory_')) return /^memory_(read|list|search|view)$/.test(lower) ? 'read' : 'write';
  for (const word of lower.split(/[\s:_-]+/)) {
    if (WRITE_WORDS.has(word)) return 'write';
    if (CODE_WORDS.has(word)) return 'code';
    if (READ_WORDS.has(word)) return 'read';
  }
  return 'default';
}

/**
 * Which animation the mark plays for the turn's current step, as Claude Code picks it: thinking before anything has
 * happened or while waiting for the model after a step, and the running tool's own motion otherwise.
 */
export function markActivity(step: ActivityStep | undefined, running: boolean): MarkActivity {
  if (!step) return 'think';
  if (step.kind === 'reasoning') return 'think';
  if (!running) return 'think';
  const it = (step.item ?? {}) as Record<string, unknown>;
  switch (step.kind) {
    case 'command':
      return commandActivity(text(it.description));
    case 'read':
    case 'search':
    case 'list':
      return 'read';
    case 'edit':
      return 'write';
    case 'web':
      return 'search';
    case 'tool':
      return toolActivity(text(it.tool) ?? '');
    default:
      return 'default';
  }
}
