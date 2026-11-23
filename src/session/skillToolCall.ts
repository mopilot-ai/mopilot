// A harness's built-in Skill tool call (Claude Code's `Skill`), read from the tool call item: the skill it loaded, the
// arguments it passed and the line it reads as, the way Claude Code's own transcript shows it ("Successfully loaded skill").
import { builtInWords } from './activityWords';
import { nameOf } from '../lib/scheduledTaskCall';
import { toolOutput } from '../lib/toolOutput';

type CallItem = {
  type?: string;
  tool?: unknown;
  server?: unknown;
  status?: string;
  error?: unknown;
  result?: { isError?: boolean } | null;
  arguments?: unknown;
};

export type SkillCall = {
  /** the skill as it is typed, without the slash ("fix-bug", "plugin:skill") */
  name: string;
  args: string;
  /** declined: the person refused it (a permission prompt); failed: it was tried and did not load */
  state: 'running' | 'loaded' | 'declined' | 'failed';
  /** what the skill said back: Claude Code's "Launching skill: name" reads as its own "Successfully loaded skill" */
  output: string;
};

const LAUNCH_RE = /^Launching skill: /;
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The skill call an item is: a built-in `Skill` tool (no MCP server) naming its skill; else null. */
export function skillCall(item: unknown): SkillCall | null {
  const it = item as CallItem | null;
  if (!it || (it.type !== 'mcpToolCall' && it.type !== 'dynamicToolCall')) return null;
  const name = nameOf(it);
  // an MCP server's tool that happens to be called Skill is that server's, not the harness's
  if (name?.tool !== 'Skill' || name.server) return null;
  const input = it.arguments as { skill?: unknown; args?: unknown } | null;
  const skill = clean(input?.skill).replace(/^\//, '');
  if (!skill) return null;
  const failed = it.status === 'failed' || !!it.error || it.result?.isError === true;
  const state =
    it.status === 'declined' ? 'declined' : failed ? 'failed' : it.status === undefined || it.status === 'completed' ? 'loaded' : 'running';
  const text = toolOutput(it).text.trim();
  const output = state === 'loaded' && (!text || LAUNCH_RE.test(text)) ? 'Successfully loaded skill' : text;
  return { name: skill, args: clean(input?.args), state, output };
}

const VERBS: Record<Exclude<SkillCall['state'], 'running'>, string> = {
  loaded: 'Loaded skill',
  declined: 'Declined skill',
  failed: 'Couldn’t load skill',
};

/**
 * The words a skill call's row reads as. A running one says what the activity line says (activityWords.ts); one Stop cut
 * off before it answered (`interrupted`) only started.
 */
export function skillCallVerb(call: SkillCall, interrupted = false): string {
  if (call.state !== 'running') return VERBS[call.state];
  return interrupted ? 'Started skill' : builtInWords('Skill', { skill: call.name })!.verb;
}

/** A running skill call as the activity line words it ("Running skill /fix-bug"), or null for any other item. */
export function runningSkillLabel(item: unknown): string | null {
  const call = skillCall(item);
  const words = call && builtInWords('Skill', { skill: call.name });
  return words ? `${words.verb} ${words.meta}` : null;
}
