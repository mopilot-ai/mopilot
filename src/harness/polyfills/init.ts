// Init polyfill (by MoPilot): Codex has no /init, so Sage asks Codex to write AGENTS.md in the
// chat's cwd. Claude's own /init stays a native passthrough: it comes through here only to offer the
// pointer to an existing AGENTS.md, which Sage appends to CLAUDE.md once /init has run. When the
// other tool's file already exists, offer a one-line pointer so each reads the other.
import { copy } from '../copy';

export type InitHarness = 'codex' | 'claude';

const FILES: Record<InitHarness, string> = { codex: 'AGENTS.md', claude: 'CLAUDE.md' };
const LABELS: Record<InitHarness, string> = { codex: 'Codex', claude: 'Claude Code' };

/** The / menu's Init line: the file the chat's own harness writes, for that harness. */
export const initDesc = (h: InitHarness) => `Create ${FILES[h]} with instructions for ${LABELS[h]}`;

export const INIT_PROMPT =
  'Analyze this codebase and create an AGENTS.md file in the repository root for future coding agents. ' +
  'Include the build, lint and test commands (including how to run a single test), the high-level architecture ' +
  'that needs reading several files to understand, and any conventions that are not obvious from the code. ' +
  'Do not invent sections or list every file. If an AGENTS.md already exists, improve it instead of rewriting it.';

/** The one line that makes `reader` load the other tool's file. Claude imports with @path; Codex is told in prose. */
export function pointerLine(reader: InitHarness): string {
  const other = FILES[reader === 'codex' ? 'claude' : 'codex'];
  return reader === 'claude' ? `@${other}` : `Also follow the instructions in ${other}.`;
}

export const hasPointer = (content: string, reader: InitHarness) => content.split(/\r?\n/).some((l) => l.trim() === pointerLine(reader));

/** The file content with the pointer appended once; unchanged when it is already there. */
export function withPointer(content: string, reader: InitHarness): string {
  if (hasPointer(content, reader)) return content;
  const body = content.replace(/\s+$/, '');
  return `${body}${body ? '\n\n' : ''}${pointerLine(reader)}\n`;
}

export interface InitPlan {
  harness: InitHarness;
  file: string;
  /** Sent to the harness as the turn's text */
  prompt: string;
  /** The target file exists: ask before replacing */
  confirmOverwrite: string | null;
  /** The other tool's file exists: offer the pointer, written into `file` once it exists */
  offer: { text: string; other: string; pointer: string } | null;
}

/**
 * What /init does in a directory, given which instruction files are already there (`pointed`: CLAUDE.md
 * already imports AGENTS.md). Codex is polyfilled; Claude gets a plan only when there is a pointer to
 * offer, and its prompt is the command as typed. Every other harness gets null.
 */
export function planInit(harness: string, exists: { agents: boolean; claude: boolean; pointed?: boolean }): InitPlan | null {
  if (harness === 'claude') {
    if (!exists.agents || exists.pointed) return null;
    const other = FILES.codex;
    return {
      harness: 'claude',
      file: FILES.claude,
      prompt: '/init',
      confirmOverwrite: null,
      offer: {
        text: copy('misc', 'initOfferRead', { other, label: LABELS.claude, file: FILES.claude }),
        other,
        pointer: pointerLine('claude'),
      },
    };
  }
  if (harness !== 'codex') return null;
  const file = FILES.codex;
  const other = FILES.claude;
  return {
    harness: 'codex',
    file,
    prompt: INIT_PROMPT,
    confirmOverwrite: exists.agents ? copy('misc', 'initOverwrite', { file }) : null,
    offer: exists.claude
      ? { text: copy('misc', 'initOfferRead', { other, label: LABELS.codex, file }), other, pointer: pointerLine('codex') }
      : null,
  };
}

/** The instruction that has the agent add the pointer line to the file it writes. */
export const pointerAsk = (plan: InitPlan & { offer: NonNullable<InitPlan['offer']> }): string =>
  `Finally, add this line at the end of ${plan.file}, once: ${plan.offer.pointer}`;

/** The prompt to send: with the offer accepted, Codex also ends AGENTS.md with the pointer line. */
export function initPrompt(plan: InitPlan, acceptedOffer: boolean): string {
  // Claude's command goes out as typed; its pointer is appended to CLAUDE.md afterwards (on a machine, asked of the agent: machineInit)
  if (plan.harness === 'claude' || !acceptedOffer || !plan.offer) return plan.prompt;
  return `${plan.prompt} ${pointerAsk({ ...plan, offer: plan.offer })}`;
}

/** What /init sends from a chat on a machine, where nothing is written from here: the command as typed, and when the person took the offer, the pointer line as one more instruction in it. */
export function machineInit(plan: InitPlan | null, typed: string, acceptedOffer: boolean): string {
  return plan?.offer && acceptedOffer ? `${typed} ${pointerAsk({ ...plan, offer: plan.offer })}` : typed;
}
