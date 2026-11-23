// Which running-activity look a chat takes (Claude Code's working mark and status line in every harness now, or Codex's
// shimmering "Working for" header), and what a running step says, in Claude Code's words.
import { HARNESS_TRAITS, type HarnessFamily, type HarnessTraits } from '../harness/family';
import { builtInWords } from './activityWords';
import { commandProgram } from '../lib/commandProgram';
import { formatDuration, prettyCommand } from '../lib/format';
import { basename } from '../lib/paths';
import { isOwnServer } from '../lib/ownToolLines';
import { nameOf } from '../lib/scheduledTaskCall';
import { ownCallLine } from '../lib/windowToolCall';
import { runningDescription } from '../lib/verbForms';

/** `dots`: Claude Code's working-mark line. `shimmer`: Codex's header and shimmering step label. */
export type ActivityUx = HarnessTraits['activity'];

/** The look of the chat's harness; ACP harnesses are "other" harnesses and take the Codex look. */
export const activityUx = (family: HarnessFamily): ActivityUx => HARNESS_TRAITS[family].activity;

/** A running step as Claude Code names it: a verb and what it acts on ("Running" "python3"), `cut` when that was shortened. */
export interface ActivityLabel {
  verb: string;
  meta?: string;
  cut?: boolean;
}

const named = (verb: string, meta: string | null | undefined, cut = false): ActivityLabel =>
  meta?.trim() ? { verb, meta: meta.trim(), ...(cut ? { cut } : {}) } : { verb };

/**
 * Claude Code's wording for the step that is running: the program a command runs (never its arguments past the plain
 * words, nor one that could carry a credential), the file read or edited, the pattern searched, the page fetched.
 */
export function claudeActivityParts(
  step:
    | {
        kind: string;
        item: unknown;
        change?: unknown;
        path?: unknown;
        query?: unknown;
        ms?: number | null;
        on?: string;
        what?: string;
        label?: string | null;
      }
    | undefined,
): ActivityLabel {
  if (!step) return { verb: 'Thinking' };
  const it = (step.item ?? {}) as {
    action?: { type?: string; url?: string | null } | null;
    server?: string | null;
    command?: string;
    query?: string | null;
    description?: string | null;
    tool?: string | null;
    arguments?: Record<string, unknown> | null;
    prompt?: string | null;
    agent?: { description?: string | null } | null;
  };
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  switch (step.kind) {
    case 'reasoning':
      return { verb: 'Thinking' };
    case 'command': {
      // the model's own description of the command, in the running form ("Run the tests" → "Running the tests")
      const description = text(it.description)?.trim();
      if (description) return { verb: runningDescription(description) ?? description };
      // a Codex command comes wrapped in its shell (`/bin/zsh -lc '…'`): the program is inside it
      const program = commandProgram(prettyCommand(String(it.command ?? '')));
      return program ? named('Running', program.text, program.cut) : { verb: 'Running', meta: 'a command' };
    }
    case 'read':
      return named('Reading', basename(text(step.path) ?? ''));
    case 'search': {
      // a search parsed without its pattern carries the whole command: never quote that
      const query = text(step.query);
      return named('Searching', query === it.command ? null : query);
    }
    case 'list':
      return named('Listing', text(step.path));
    case 'edit': {
      const change = step.change as { path?: string; kind?: { type?: string } } | undefined;
      return named(change?.kind?.type === 'add' ? 'Creating' : 'Editing', basename(change?.path ?? ''));
    }
    case 'web':
      return it.action?.type === 'openPage' ? named('Fetching', it.action.url) : named('Searching web', it.query);
    case 'tool': {
      // MoPilot's own tools read as what they do ("Searching memory"), never as the tool's raw name
      const own = ownCallLine(step.item);
      if (own) return { verb: own.text };
      const name = nameOf({ tool: text(it.tool)?.trim(), server: it.server });
      const tool = name?.tool ?? '';
      // MoPilot's own server (sage_<nonce>) is no name to show
      const server = name?.server ?? it.server ?? '';
      if (!isOwnServer(server)) return { verb: tool ? `Using ${server}: ${tool.replace(/_+/g, ' ')}` : `Using ${server}` };
      return builtInWords(tool, it.arguments) ?? { verb: tool ? `Using ${tool}` : 'Using a tool' };
    }
    case 'wait':
      return named('Waiting', step.on ? `for ${step.on}` : formatDuration(step.ms));
    case 'watch':
      // a check-in reads as Claude Code's own words for ScheduleWakeup ("Stopping loop" when it ends one)
      return step.what === 'monitor'
        ? named('Starting monitor', step.label)
        : (builtInWords('ScheduleWakeup', it.arguments) as ActivityLabel);
    case 'agent': {
      // an agent says what it is doing in the running form, as Claude Code's Agent row does
      const description = (text(it.agent?.description) ?? text(it.prompt) ?? text(it.description))?.trim();
      return description ? { verb: runningDescription(description) ?? description } : { verb: 'Running agent' };
    }
    default:
      return { verb: 'Working' };
  }
}

/** The status line's wording of a label: verb and detail, without the mark of a shortened command. */
export const activityText = ({ verb, meta }: ActivityLabel): string => (meta ? `${verb} ${meta}` : verb);

/** A running row's wording of a label: the status line's, with the mark of a shortened command ("Running python3…"). */
export const activityRowText = (label: ActivityLabel): string => `${activityText(label)}${label.cut ? '…' : ''}`;

/** The status line's wording for a running step. */
export const claudeActivityLabel = (step: Parameters<typeof claudeActivityParts>[0]): string => activityText(claudeActivityParts(step));
