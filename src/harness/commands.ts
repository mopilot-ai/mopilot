// The command registry: Sage's own UI commands plus the current segment's CommandProvider.
// Native commands pass through by default; typed commands and the / menu come from the same list.
import { claudeSkipped } from '../../shared/claudeSlash.mjs';
import { ownTable } from '../../shared/ownTable.mjs';
import type { Binding, CommandInfo, Semantic, Why } from './adapter';
import { initDesc, type InitHarness } from './polyfills/init';

/**
 * One harness's commands. `native` are the ones the harness runs itself (sent verbatim); `sage` are
 * the ones Sage dispatches for this harness (Codex's rpc table, Claude's interactive-only screens).
 * `listed` is false for a basic harness that never pushed available_commands_update (dsh): every
 * typed /xxx then goes to it verbatim.
 */
export interface CommandProvider {
  kind: 'codex' | 'claude' | 'acp';
  label: string;
  listed: boolean;
  native: CommandInfo[];
  sage: CommandInfo[];
  /** typed `/<command> <argument>` that runs one of the `sage` entries instead (`design login` → `design-login`) */
  routes?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Sage's own commands                                                 */
/* ------------------------------------------------------------------ */
export const APP_COMMANDS: CommandInfo[] = [
  { name: 'new', aliases: ['clear', 'reset'], description: 'Start a new chat', semantic: 'clear', source: 'app', dispatch: 'ui' },
  { name: 'settings', description: 'Open settings', source: 'app', dispatch: 'ui' },
  { name: 'diff', description: 'Show the git diff, including untracked files', source: 'app', dispatch: 'ui' },
  { name: 'fork', description: 'Fork this chat into a new one', semantic: 'fork', source: 'app', dispatch: 'ui' },
  { name: 'tasks', description: 'Show background tasks and agents', semantic: 'tasks', source: 'app', dispatch: 'ui' },
  { name: 'model', description: 'Choose what model and reasoning effort to use', semantic: 'model', source: 'app', dispatch: 'ui' },
  { name: 'permissions', description: 'Choose what the agent is allowed to do', semantic: 'permissions', source: 'app', dispatch: 'ui' },
  // MoPilot's bug report on every harness (no semantic, so no harness's caps hide it); on Codex it can also go to OpenAI
  { name: 'bug', description: 'Report a bug to MoPilot, with this chat', source: 'app', dispatch: 'ui' },
  { name: 'feedback', description: 'Send feedback about this chat to MoPilot', source: 'app', dispatch: 'ui' },
];
/** Always Sage's, whatever the harness lists. /exit is never sent. */
const RESERVED = new Set(['new', 'clear', 'reset', 'settings', 'diff', 'fork', 'tasks', 'exit', 'bug', 'feedback']);
/** Sage's without arguments; with arguments a native command of the same name gets them. */
const UI_WITHOUT_ARGS = new Set(['model', 'permissions']);

/* ------------------------------------------------------------------ */
/* Provider 1: Codex static table (gated through caps)                 */
/* ------------------------------------------------------------------ */
const CODEX_TABLE: CommandInfo[] = [
  {
    name: 'goal',
    description: 'Set a goal for Codex to keep pursuing',
    hint: '<objective> | clear',
    semantic: 'goal',
    source: 'builtin',
    dispatch: 'rpc',
  },
  {
    name: 'review',
    description: 'Review my current changes and find issues',
    hint: '[instructions]',
    semantic: 'review',
    source: 'builtin',
    dispatch: 'rpc',
  },
  {
    name: 'compact',
    description: 'Summarize the conversation to free up context',
    semantic: 'compact',
    source: 'builtin',
    dispatch: 'rpc',
  },
  { name: 'init', description: 'Create AGENTS.md for Codex · by MoPilot', semantic: 'init', source: 'app', dispatch: 'polyfill' },
  { name: 'rename', description: 'Rename this chat', hint: '<name>', semantic: 'rename', source: 'builtin', dispatch: 'rpc' },
  { name: 'status', description: 'Show session configuration and token usage', semantic: 'status', source: 'builtin', dispatch: 'ui' },
  { name: 'mcp', description: 'List configured MCP servers', semantic: 'mcp', source: 'builtin', dispatch: 'ui' },
  { name: 'skills', description: 'Browse and manage skills', semantic: 'skills', source: 'builtin', dispatch: 'ui' },
  { name: 'logout', description: 'Choose an account to log out of', semantic: 'logout', source: 'builtin', dispatch: 'rpc' },
  // the composer's own mode switch, typed as on Claude Code (CLAUDE_SAGE)
  { name: 'plan', description: 'Turn plan mode on or off', semantic: 'plan', source: 'app', dispatch: 'ui' },
];
/** Codex has no command catalog: Sage runs every Codex command through its RPCs. Feature gates arrive through caps. */
export const codexCommands = (): CommandProvider => ({
  kind: 'codex',
  label: 'Codex',
  listed: true,
  native: [],
  sage: CODEX_TABLE.map((c) => ({ ...c })),
});

/* ------------------------------------------------------------------ */
/* Provider 2: Claude supportedCommands / commands_changed             */
/* ------------------------------------------------------------------ */
/** Fields Claude Code 2.1.295 reports for each command. */
export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

/** Interactive-only in the CLI ("isn't available in this environment"); Sage draws these itself. */
// left out of the Chrome side panel's / menu too (shared/claudeSlash.mjs)
export { CLAUDE_INTERACTIVE_ONLY } from '../../shared/claudeSlash.mjs';
const CLAUDE_SAGE: CommandInfo[] = [
  { name: 'status', description: 'Show session configuration and token usage', semantic: 'status', source: 'app', dispatch: 'ui' },
  { name: 'memory', description: 'Edit CLAUDE.md and memory', semantic: 'memory', source: 'app', dispatch: 'ui' },
  { name: 'plan', description: 'Turn plan mode on or off', semantic: 'plan', source: 'app', dispatch: 'ui' },
];

/**
 * Claude Design's sign-in. Claude Code's own /design-login is an interactive panel that an SDK session refuses (it
 * isn't even listed), so Sage runs the CLI's host sign-in for it (electron/harness/claude/designLogin.cjs). Offered where
 * Claude lists its Design commands, since the CLI enables both together; `/design login` is routed to it too.
 */
const CLAUDE_DESIGN_LOGIN: CommandInfo = {
  name: 'design-login',
  description: 'Authorize Claude Design for this account · by MoPilot',
  source: 'app',
  dispatch: 'ui',
};
const CLAUDE_DESIGN_COMMANDS = new Set(['design', 'design-consent']);

const CLAUDE_SEMANTIC: Record<string, Semantic> = ownTable({
  goal: 'goal',
  compact: 'compact',
  init: 'init',
  'code-review': 'review',
  'security-review': 'review',
  ultrareview: 'review',
  model: 'model',
  mcp: 'mcp',
  context: 'status',
  usage: 'status',
  rename: 'rename',
  loop: 'workflows',
  schedule: 'workflows',
});

export function claudeCommands(supported: ClaudeSlashCommand[], o: { terminalSlash?: string[]; skills?: string[] } = {}): CommandProvider {
  const skip = claudeSkipped(o.terminalSlash ?? []);
  const skills = new Set(o.skills ?? []);
  const native = supported
    .filter((c) => !skip.has(c.name))
    .map(
      (c): CommandInfo => ({
        name: c.name,
        ...(c.aliases?.length ? { aliases: c.aliases } : {}),
        description: c.name === 'schedule' ? 'Cloud routine on claude.ai (not in MoPilot Scheduled)' : c.description,
        ...(c.argumentHint ? { hint: c.argumentHint } : {}),
        ...(CLAUDE_SEMANTIC[c.name] ? { semantic: CLAUDE_SEMANTIC[c.name] } : {}),
        source: skills.has(c.name) ? 'skill' : c.builtin ? 'builtin' : 'custom',
        dispatch: 'passthrough',
      }),
    );
  const sage = CLAUDE_SAGE.map((c) => ({ ...c }));
  const design = supported.some((c) => CLAUDE_DESIGN_COMMANDS.has(c.name)) && !supported.some((c) => c.name === CLAUDE_DESIGN_LOGIN.name);
  if (!design) return { kind: 'claude', label: 'Claude Code', listed: true, native, sage };
  return {
    kind: 'claude',
    label: 'Claude Code',
    listed: true,
    native,
    sage: [...sage, { ...CLAUDE_DESIGN_LOGIN }],
    routes: { 'design login': CLAUDE_DESIGN_LOGIN.name },
  };
}

/* ------------------------------------------------------------------ */
/* Provider 3: ACP available_commands_update                           */
/* ------------------------------------------------------------------ */
export interface AcpAvailableCommand {
  name: string;
  description: string;
  input?: { hint?: string } | null;
}

/** `update` is null until the harness pushes a catalog; each push replaces the last one. */
export function acpCommands(label: string, update: AcpAvailableCommand[] | null, own: CommandInfo[] = []): CommandProvider {
  const kept = (update ?? []).filter((c) => !own.some((o) => o.name === c.name.replace(/^\//, '')));
  const native = kept.map(
    (c): CommandInfo => ({
      name: c.name.replace(/^\//, ''),
      description: c.description,
      ...(/^(compact|compress)$/.test(c.name.replace(/^\//, '')) ? { semantic: 'compact' as const } : {}),
      ...(c.input?.hint ? { hint: c.input.hint } : {}),
      source: 'custom',
      dispatch: 'passthrough',
    }),
  );
  return { kind: 'acp', label, listed: update !== null, native, sage: own };
}

/**
 * What a chat that runs Claude Code or Codex on a machine keeps as this app's own, whatever the agent lists: its goal and
 * /init are the ones a chat on this Mac has (the machine's agent runs them, see the goal bar and runInit), not text sent to it.
 */
export const machineCommands = (agent: InitHarness): CommandInfo[] => [
  ...CODEX_TABLE.filter((c) => c.name === 'goal').map((c) => ({ ...c })),
  { name: 'init', description: initDesc(agent), semantic: 'init', source: 'app', dispatch: 'polyfill' },
];

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */
export interface CommandRegistry {
  provider: CommandProvider;
  /** what the / menu shows; entries with a why are greyed out */
  menu: CommandInfo[];
  /** hidden by a harness-layer none; typing one shows a note instead of sending */
  hidden: CommandInfo[];
}

/** A binding that says why it is off. A chat whose capabilities haven't arrived yet reads 'absent', with no Why: it filters nothing. */
const noneOf = (b: Binding | undefined): Extract<Binding, { via: 'none' }> | null => (b?.via === 'none' && b.why ? b : null);

const names = (c: CommandInfo) => [c.name, ...(c.aliases ?? [])];

/**
 * Sage's commands first, then the provider's. A native command with the same name replaces Sage's,
 * except the reserved UI ones. Caps decide the rest: a harness-layer none hides Sage's own entries;
 * any other none greys the entry out with its Why.
 */
export function composeCommands(
  provider: CommandProvider,
  caps?: Partial<Record<Semantic, Binding>>,
  app: CommandInfo[] = APP_COMMANDS,
): CommandRegistry {
  const native = new Set(provider.native.flatMap(names));
  const menu: CommandInfo[] = [];
  const hidden: CommandInfo[] = [];
  for (const c of [...app, ...provider.sage]) {
    if (!RESERVED.has(c.name) && !UI_WITHOUT_ARGS.has(c.name) && native.has(c.name)) continue;
    const b = noneOf(c.semantic ? caps?.[c.semantic] : undefined);
    if (b?.why.layer === 'harness') hidden.push({ ...c, why: b.why });
    else menu.push(b ? { ...c, why: b.why } : c);
  }
  const taken = new Set(menu.flatMap(names));
  for (const c of provider.native) {
    if (RESERVED.has(c.name) || taken.has(c.name)) continue;
    const b = noneOf(c.semantic ? caps?.[c.semantic] : undefined);
    // a command the harness itself lists is never hidden; other layers still grey it out
    menu.push(b && b.why.layer !== 'harness' ? { ...c, why: b.why } : c);
  }
  return { provider, menu, hidden };
}

/**
 * The / menu's App group: what Sage dispatches itself and the menu doesn't already draw, so the
 * entries typing can run are also in the menu. `runnable` are the names Sage has a handler for;
 * `skip` are the ones the menu draws its own way.
 */
export const appEntries = (menu: CommandInfo[], taken: Set<string>, runnable: Set<string>, skip: Set<string>) =>
  menu.filter((c) => c.dispatch !== 'passthrough' && !taken.has(c.name) && !skip.has(c.name) && runnable.has(c.name));

/* ------------------------------------------------------------------ */
/* Typed input                                                         */
/* ------------------------------------------------------------------ */
export type TypedCommand =
  | { kind: 'text' }
  | { kind: 'ui' | 'rpc' | 'polyfill'; command: CommandInfo; args: string }
  | { kind: 'passthrough'; text: string; command?: CommandInfo }
  | { kind: 'disabled'; command: CommandInfo; why: Why }
  | { kind: 'hidden'; command: CommandInfo; why: Why }
  | { kind: 'unknown'; name: string; note: string }
  | { kind: 'blocked'; name: string };

/**
 * Only the first token counts, shaped like /name and not followed by a path character, so
 * "/usr/local/bin has no node" stays a question.
 */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z][\w:-]*)(?=\s|$)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1], args: m[2].trim() };
}

const find = (list: CommandInfo[], name: string) => list.find((c) => names(c).includes(name));

/**
 * The skill a sent message starts, when its first token names one the chat's harness lists as a skill; null for plain
 * text, a command and a harness that lists no skills. `rest` is the text after the name as it was sent, with the space or
 * line break before it ("/fix-bug\ntidy up" → fix-bug, "\ntidy up").
 */
export function sentSkill(text: string, provider: CommandProvider | null): { name: string; rest: string } | null {
  const p = provider && parseSlash(text);
  if (!p || find(provider.native, p.name)?.source !== 'skill') return null;
  return { name: p.name, rest: text.trim().slice(p.name.length + 1) };
}

export function resolveTyped(text: string, reg: CommandRegistry): TypedCommand {
  const p = parseSlash(text);
  if (!p) return { kind: 'text' };
  const { provider } = reg;
  if (p.name === 'exit') return { kind: 'blocked', name: p.name };
  // Sage's entries are the ones it dispatches itself
  const own = reg.menu.filter((c) => c.dispatch !== 'passthrough');
  const route = provider.routes?.[`${p.name} ${p.args.toLowerCase()}`];
  const routed = route ? find(own, route) : undefined;
  if (routed) return dispatch(routed, '');
  const native = find(provider.native, p.name);
  const app = find(own, p.name);

  if (app && (RESERVED.has(p.name) || (UI_WITHOUT_ARGS.has(app.name) && (!p.args || !native)))) return dispatch(app, p.args);
  if (native) {
    // a native shadowed by Sage's no-args entry (/model opus) shares that entry's semantic and Why
    const shown =
      find(
        reg.menu.filter((c) => c.dispatch === 'passthrough'),
        p.name,
      ) ?? app;
    if (shown?.why) return { kind: 'disabled', command: shown, why: shown.why };
    if (native.semantic === 'compact') return dispatch({ ...native, name: 'compact', dispatch: 'rpc' }, p.args);
    return { kind: 'passthrough', text: text.trim(), command: native };
  }
  if (app) return dispatch(app, p.args);

  // unlisted basic harness: Sage UI commands above, everything else verbatim
  if (provider.kind === 'acp' && !provider.listed) return { kind: 'passthrough', text: text.trim() };
  const hid = find(reg.hidden, p.name);
  if (hid?.why) return { kind: 'hidden', command: hid, why: hid.why };
  // Claude hands unknown commands to the model itself
  if (provider.kind === 'claude') return { kind: 'passthrough', text: text.trim() };
  const note =
    provider.kind === 'codex'
      ? "Codex doesn't have this command · Send as plain text"
      : `${provider.label} doesn't list /${p.name} · Send as plain text`;
  return { kind: 'unknown', name: p.name, note };
}

/** One of Sage's own entries (the menu filter above leaves out passthrough ones). */
function dispatch(c: CommandInfo, args: string): TypedCommand {
  if (c.why) return { kind: 'disabled', command: c, why: c.why };
  return { kind: c.dispatch as 'ui' | 'rpc' | 'polyfill', command: c, args };
}

/** What typing after "/" matches: the start of the command name, its aliases or the title, never a substring. */
export const slashNames = (c: { id: string; title: string; aliases?: string[] }) =>
  [c.id, c.title.replace(/^\//, '').replace(/ \(.*$/, ''), ...(c.aliases ?? [])].map((n) => n.toLowerCase());
