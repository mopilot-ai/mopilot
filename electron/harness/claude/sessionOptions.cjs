// What a Claude Code CLI process starts with and is fed: the SDK options, permission modes, user messages, flag settings and its streaming input.
const crypto = require('node:crypto');
const { INPUT_GUIDANCE: CHROME_INPUT_GUIDANCE } = require('./chromeTabs.cjs');
const { sdkBin } = require('./cli.cjs');
const { literalMessage } = require('./message.cjs');
const { vendorSkillOverrides, toolNamespaceNote } = require('../../plugins/contract/vendorSkills.cjs');

/** Background helper queries never attach a browser. User sessions opt into Claude in Chrome (nativeChromeFor). */
const noChrome = () => ({ 'no-chrome': null });

/** How long the model notes MoPilot sends as MCP server instructions may be before the CLI cuts them. */
const MCP_INSTRUCTIONS_CHARS = 16384;

/** Async queue used as the SDK's streaming input. */
class Channel {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(v) {
    if (this.closed) return;
    this.items.push(v);
    this.waiters.shift()?.();
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length) yield this.items.shift();
      else if (this.closed) return;
      else await new Promise((r) => this.waiters.push(r));
    }
  }
}

/** @returns {{ permissionMode: import('@anthropic-ai/claude-agent-sdk').PermissionMode, allowedTools?: string[] }} */
function permissionMode(perm) {
  switch (perm) {
    case 'read-only':
      return {
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookRead'],
      };
    case 'auto-review':
      return { permissionMode: 'auto' };
    case 'full-access':
      return { permissionMode: 'bypassPermissions' };
    case 'plan':
      return { permissionMode: 'plan' };
    default:
      return { permissionMode: 'default' };
  }
}

/**
 * Read-only is a mode plus a tool whitelist, and the whitelist is only set when the process starts.
 * A process started in another mode restarts (resuming from disk) when a chat moves into or out of read-only (D-28).
 */
const wantsReadOnly = (opts) => (opts.permission === 'plan' ? opts.basePermission : opts.permission) === 'read-only';

/** The native mode a plan returns to once approved: the chat's own permission (never plan itself). */
function restoreMode(perm) {
  const mode = permissionMode(perm).permissionMode;
  return mode === 'plan' ? 'default' : mode;
}

/**
 * Approving ExitPlanMode goes back to the mode the chat had before plan. Without a setMode the CLI
 * falls back to its own pre-plan mode, which is 'default' for a session started in plan.
 */
function planApproval(toolName, result, mode) {
  if (toolName !== 'ExitPlanMode' || result?.behavior !== 'allow') return result;
  if (result.updatedPermissions?.some((u) => u?.type === 'setMode')) return result;
  return {
    ...result,
    updatedPermissions: [...(result.updatedPermissions ?? []), { type: 'setMode', mode: mode || 'default', destination: 'session' }],
  };
}

/**
 * The SDK options for a chat's CLI. Without a systemPrompt the SDK sends an empty one, so ask for
 * Claude Code's own; `snapshot` records it once per conversation so the cached prefix stays stable.
 * Every session may switch to bypassPermissions later (a plan approved under Full access, or a
 * mid-chat switch); Sage only sets that mode when the user picked Full access.
 * @param opts the chat's session options (cwd, model, effort, permission, fast)
 * @param {{ bin?: string, spawn?: import('@anthropic-ai/claude-agent-sdk').Options['spawnClaudeCodeProcess'], nativeChrome?: boolean, env?: Record<string, string | undefined>, stderr?: (data: string) => void,
 *           onSpawned?: (pid: number) => void,
 *           canUseTool?: (toolName: string, input: Record<string, unknown>, options: any) => any, onElicitation?: import('@anthropic-ai/claude-agent-sdk').Options['onElicitation'] }} [extra]
 * @returns {import('@anthropic-ai/claude-agent-sdk').Options & { onProcessSpawned?: (pid: number) => void }}
 */
function buildSessionOptions(opts, extra = {}) {
  return {
    pathToClaudeCodeExecutable: sdkBin(extra.bin),
    // a process that starts Claude Code itself (the Host, which tracks its children) says how
    ...(extra.spawn ? { spawnClaudeCodeProcess: extra.spawn } : {}),
    cwd: opts.cwd,
    ...(opts.additionalDirectories ? { additionalDirectories: opts.additionalDirectories } : {}),
    model: opts.model || undefined,
    effort: opts.effort || undefined,
    ...permissionMode(opts.permission),
    // a plan approved in a read-only chat returns to dontAsk, which needs its whitelist
    ...(opts.permission === 'plan' && opts.basePermission === 'read-only'
      ? { allowedTools: permissionMode('read-only').allowedTools }
      : {}),
    allowDangerouslySkipPermissions: true,
    // Stop ends the turn only; background agents keep running and are stopped one by one (stopTask)
    perTaskStopAffordance: true,
    // sub-agents' own text and tool calls arrive with their parent_tool_use_id, for the Agent card
    forwardSubagentText: true,
    // edit-and-resend rewinds files to a user message (rewindFiles); the uuid is Sage's own (C14)
    enableFileCheckpointing: true,
    // User-facing hook feedback arrives as informational messages, as in Claude Desktop; raw hook events stay internal.
    // Running sub-agents get a one-line progress summary (task_progress).
    agentProgressSummaries: true,
    // with Claude in Chrome, how to make its first click or typing in a page land (harness/claude/chromeTabs.cjs)
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      snapshot: true,
      append: [extra.nativeChrome ? CHROME_INPUT_GUIDANCE : '', toolNamespaceNote({ nativeChrome: !!extra.nativeChrome })]
        .filter(Boolean)
        .join('\n\n'),
    },
    includePartialMessages: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    settingSources: ['user', 'project', 'local'],
    // vendor skills for Claude Desktop's tools are hidden (plugins/contract/vendorSkills.cjs)
    settings: { ...(opts.fast ? { fastMode: true } : {}), skillOverrides: vendorSkillOverrides({ nativeChrome: !!extra.nativeChrome }) },
    // /code-review reports its findings with the ReportFindings tool, which the review card shows as a typed list; the CLI says when
    // its turn is over (session_state_changed), which ends the chat's turn (shared/claudeTurnOver.mjs)
    // MoPilot's tool notes reach the model as MCP server instructions, which the CLI cuts at 4096 characters by
    // default, dropping the task-list and sessions notes at their end; a value the user exported wins
    env: {
      CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: String(MCP_INSTRUCTIONS_CHARS),
      ...(extra.env ?? process.env),
      CLAUDE_CODE_REPORT_FINDINGS: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    },
    stderr: extra.stderr,
    // the CLI's pid, to record what it starts: the SDK's own (untyped) hook, so its spawn stays the SDK's (#1486)
    onProcessSpawned: extra.onSpawned,
    canUseTool: extra.canUseTool,
    // helper queries and sessions outside nativeChromeFor keep --no-chrome
    extraArgs: extra.nativeChrome ? { chrome: null } : noChrome(),
    onElicitation: extra.onElicitation,
  };
}

/**
 * One message for the CLI's input. Only text the user typed carries origin human: the CLI keeps
 * human-only behavior (the "ultracode" keyword) to those, not to text Sage writes itself. Each gets
 * a uuid, Sage's own id for it when it has one.
 */
/**
 * @param message
 * @param {{ priority?: string, human?: boolean, uuid?: string }} [opts]
 */
/**
 * The CLI's user line for a message. `literal`: a MoMo chat's, whose text is never one of the CLI's own commands
 * (/clear, /compact): it goes as plain text (message.cjs literalMessage, #3665).
 * @param {any} message
 * @param {{ priority?: string, human?: boolean, uuid?: string, literal?: boolean, compact?: { args: string } }} [o]
 */
function buildUserMessage(message, { priority, human, uuid, literal = false, compact } = {}) {
  return {
    type: 'user',
    message: literal && !compact ? literalMessage(message) : message,
    parent_tool_use_id: null,
    session_id: '',
    uuid: uuid || crypto.randomUUID(),
    ...(priority ? { priority } : {}),
    ...(human ? { origin: { kind: 'human' } } : {}),
  };
}

/**
 * Flag settings for applyFlagSettings. An effortLevel sent without `ultracode` turns ultracode
 * off, so it goes along with the session's ultracode whenever that's known. `applied` is what
 * getSettings last reported, for ultracode the user turned on in the CLI itself (/effort ultracode on).
 */
function flagSettings(s, settings, applied) {
  const out = { ...settings };
  if ('ultracode' in out) s.ultracode = out.ultracode ?? undefined;
  else if ('effortLevel' in out && s.ultracode !== undefined) out.ultracode = s.ultracode;
  else if ('effortLevel' in out && applied?.ultracode === true) out.ultracode = true;
  return out;
}

/** The SDK's ElicitationResult for a window's answer: the answer's content and _meta pass through as given. */
function elicitationResult(r) {
  if (!r?.action) return { action: 'decline' };
  return {
    action: r.action,
    ...(Object.hasOwn(r, 'content') && r.content != null ? { content: r.content } : {}),
    ...(Object.hasOwn(r, '_meta') && r._meta != null ? { _meta: r._meta } : {}),
  };
}

module.exports = {
  MCP_INSTRUCTIONS_CHARS,
  noChrome,
  Channel,
  permissionMode,
  wantsReadOnly,
  restoreMode,
  planApproval,
  buildSessionOptions,
  buildUserMessage,
  flagSettings,
  elicitationResult,
};
