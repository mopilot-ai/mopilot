#!/usr/bin/env node
// A scripted stand-in for the `claude` CLI used by the e2e tests. The app drives it the way it
// drives the real one, through @anthropic-ai/claude-agent-sdk: the SDK spawns it with
// `--output-format stream-json --input-format stream-json` and talks newline-delimited JSON over
// stdio, user messages in and SDK messages out, with control_request / control_response pairs both
// ways. The fake speaks just enough of that for the app:
//   - `--version`, `auth status --json` (a signed-in fake subscription, or signed out with
//     FAKE_CLAUDE_AUTH=signed-out), `auth login|logout` (which sign in and out for later runs; a login waits while
//     "$FAKE_CLAUDE_LOG.hold-login" exists, as a real one waits for the browser), and `-p <prompt>` (the login check);
//   - initialize (models, account, commands), interrupt, rename_session (fake-claude-rename.mjs), and a success response to anything else;
//   - per user message: system/init, a streamed assistant reply "fake-claude: <text>", a result.
//     A message containing "SLOW" streams its reply and then waits for an interrupt;
//   - "/goal <condition>" as Claude Code runs it: a synthetic "Goal set: <condition>", then two
//     unmet checks ("Stop hook feedback" synthetic user messages), then the condition is met (a
//     goal_status record in the transcript) and the turn ends. A condition containing "SLOW" keeps
//     checking until interrupted, and the goal stays set, as in the CLI. A condition containing "CRASH"
//     makes the process die after its first round (SIGKILL-like, no result), the goal staying set in
//     the session, which a reopened process (--resume) still holds. "/goal" and "/goal clear"
//     answer with local command output;
//   - "MCPCALL <word>": for each in-process SDK MCP server named sage_<nonce> (initialize's sdkMcpServers), the
//     CLI's side of the SDK's mcp_message control requests (initialize, tools/list), a can_use_tool
//     request for mcp__<server>__sage_debug_echo, then tools/call; the answers go in the reply.
//     "MCPREPO" asks can_use_tool for mcp__sage__sage_debug_echo, as a repo's own MCP server named
//     "sage" would, and puts the decision in the reply. Each outcome is logged as {kind: 'mcp'};
//   - "CUCALL <tool> <json args>": the same, calling a computer-use tool (computer_click, ...) with those
//     arguments; the answer's text goes in the reply as [cu: ...] (images as <image>). A message made of several
//     CUCALL lines runs each, in order, in the same turn. A full name
//     mcp__<server>__<tool> calls that SDK server's tool instead (the host servers, e.g. mopilot_browser). A message
//     containing "CUSTEPS" makes them tool calls as the CLI shows them (a tool_use, then its tool_result), and an
//     interrupt then ends the turn at once, leaving the call in flight unanswered as the CLI does;
//   - "SUBCUCALL <tool> <json args>": the same, made by a sub-agent (its tool_use carries a parent_tool_use_id);
//   - plan mode: a message containing "PLAN" in plan mode presents a plan with ExitPlanMode (see
//     presentPlan); set_permission_mode and an approved plan announce the new mode in system/status;
//   - "BGTASK <what>": a background Agent with task_* events, background_tasks_changed, a sub-agent
//     step and a progress summary; it runs until stop_task, or an interrupt when the app didn't
//     declare perTaskStopAffordance. "BGWORKFLOW <name>" is a background workflow task (local_workflow,
//     stage "Stage 2 of 3") with two sub-agent tasks under it. get_settings and apply_flag_settings model ultracode (C6);
//   - checkpoints: with CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING a file-history snapshot per prompt; rewind_files lists
//     notes.txt (logged as {kind: 'rewind'}); --resume-session-at continues the transcript from that entry;
//   - commands: aliases (code-review: review), a terminal-only /doctor (init.terminal_slash_commands)
//     and a skill listed as a command; "CMDCHANGE" sends commands_changed with one more; "ELICIT" asks
//     the app for an MCP form (elicitation), "ASKMULTI" a multiSelect AskUserQuestion, "DENYME" a
//     WebFetch approval (fake-claude-asks.mjs), each answer logged and put in the reply; "HOOKFAIL" reports a failed hook;
//   - THINKTWICE, HOOKOK / HOOKFAIL, CTXUSE, FAKE_CLAUDE_1M and a held next turn: fake-turn-details.mjs; FOLDSTEER (with RUNCMDSTREAM, a steer folded into the turn): fake-claude-fold.mjs;
//   - "RUNCMDSTREAM": a foreground Bash (with LOOP, `npm test` in a `for` loop) that keeps running (task_started, get_task_output answers with growing output) until $FAKE_CLAUDE_LOG.release exists; "LABELCHURN" (24 Bash calls with long, changing descriptions) and "FGTASK": fake-turn-details.mjs;
//   - "RUNCMD" (Bash `npm test`; RUNCMDFAIL exits 3, RUNCMDTIMEOUT fails with no exit code) and "EDITFILE" (Write hello.txt in the cwd): tool calls that wait on the app's
//     approval unless the mode allows them; the outcome is put in the reply as [command: ran|declined] / [edit: written|declined];
//   - "/code-review [args]" (and /review) in the last block runs as a forked review task (runReview in
//     fake-claude-review.mjs), logged as {kind: 'review'} with the message's block types; with REPORT in its
//     args it runs inline and reports two findings through a ReportFindings tool call, as the CLI's
//     /code-review does with CLAUDE_CODE_REPORT_FINDINGS;
//   - a session transcript in $CLAUDE_CONFIG_DIR/projects/<cwd slug>/<session id>.jsonl in the real CLI's format, so the app's listing and resume of Claude chats work;
//   - several logins: an account folder (CLAUDE_CONFIG_DIR other than ~/.claude) is signed in as
//     <folder name>@example.test, and a login whose folder holds a ".fake-limited" file is out of
//     usage: every turn (and every goal round) ends on a rejected rate limit, as the CLI reports it. A ".fake-signed-out"
//     file in a login's folder makes `auth status` report it signed out. A ".fake-usage-full" file there makes `/usage` say its plan
//     windows are used up, while its turns still run. A ".fake-expired" file there is a lapsed OAuth
//     token: `auth status` still says logged in (as the real CLI does) but every turn ends on authentication_failed, until
//     `auth login` for that folder removes the file.
//   - PROVIDERRETRY, LOGINEXPIRED and RUNCMDLATER: provider trouble and a late approval (fake-claude-trouble.mjs);
// Every inbound line (and the argv it was started with) is appended to $FAKE_CLAUDE_LOG (JSONL).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createFakeClaudeTools } from './fake-claude-tools.mjs';
import { fakeMomoReply, fakeControlText, fakeTextOf as textOf, withoutMomoContext } from './fake-control-text.mjs';
import { fakeClaudeUsage } from './fake-claude-usage.mjs';
import { holdWhileMarked, marked } from './fake-claude-marks.mjs';
import { claudeHookResponses, claudeUsage, extraClaudeModels, heldNext, released, streamClaudeThoughts } from './fake-turn-details.mjs';
import { cloudEnvOf, holdStart, scriptedToolTurns } from './fake-turn-details.mjs';
import { drainQueue } from './fake-claude-fold.mjs';
import { refusedTurn } from './fake-claude-limits.mjs';
import { runLocalCommand } from './fake-claude-local.mjs';
import { createFakeClaudeReview } from './fake-claude-review.mjs';
import { askTheApp } from './fake-claude-asks.mjs';
import { renameSession, remoteControl } from './fake-claude-rename.mjs';
import { createFakeClaudeTrouble } from './fake-claude-trouble.mjs';
import { cuCallsOf } from './fake-cu-calls.mjs';

const VERSION = '999.0.0';
const args = process.argv.slice(2);
const LOG = process.env.FAKE_CLAUDE_LOG;
// an API key, or the bearer token a gateway takes (an endpoint key, MoPilot credits), in the environment counts as
// a login, as in the real CLI
const envKey = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// FAKE_CLAUDE_AUTH=signed-out starts signed out; `auth login` signs in and `auth logout` signs out again (markers next to the log)
const signedIn = () => {
  // a login whose own folder holds a ".fake-signed-out" file has lapsed
  if (fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.fake-signed-out'))) return false;
  if (LOG && fs.existsSync(`${LOG}.logout`)) return envKey();
  if (LOG && fs.existsSync(`${LOG}.login`)) return true;
  return process.env.FAKE_CLAUDE_AUTH !== 'signed-out' || envKey();
};
const SIGNED_IN = signedIn();
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const IS_ACCOUNT = path.basename(CONFIG_DIR) !== '.claude';
const EMAIL = IS_ACCOUNT ? `${path.basename(CONFIG_DIR)}@example.test` : 'fake-user@example.test';
const LIMITED = marked(CONFIG_DIR, '.fake-limited');
// a login whose folder holds a ".fake-usage-full" file reads as out of usage in /usage, with no turn ever refused
const USAGE_FULL = marked(CONFIG_DIR, '.fake-usage-full');
const STEP_MS = 15;

function log(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + '\n');
  } catch {
    /* debug log only: a failed write must not break the fake CLI */
  }
}

/** `--flag=value` or `--flag value`; true for a bare flag; undefined when absent. */
function flag(name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* one-shot commands                                                   */
/* ------------------------------------------------------------------ */
if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === 'auth') {
  log({ kind: 'argv', argv: args, configDir: process.env.CLAUDE_CONFIG_DIR });
  if (args[1] === 'status') {
    holdWhileMarked(CONFIG_DIR, '.fake-status-hold');
    if (process.env.FAKE_CLAUDE_STATUS_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_STATUS_MS)));
    const status = SIGNED_IN
      ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: EMAIL, orgName: 'Fake Org', subscriptionType: 'max' }
      : { loggedIn: false, authMethod: null, apiProvider: null };
    process.stdout.write(JSON.stringify(status) + '\n');
    process.exit(0);
  }
  if (args[1] === 'login' || args[1] === 'logout') {
    // a test holding the login ("$FAKE_CLAUDE_LOG.hold-login") keeps it, and its terminal, open until it lets go
    while (args[1] === 'login' && LOG && fs.existsSync(`${LOG}.hold-login`))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    if (args[1] === 'login') fs.rmSync(path.join(CONFIG_DIR, '.fake-expired'), { force: true });
    if (LOG) {
      fs.rmSync(`${LOG}.${args[1] === 'login' ? 'logout' : 'login'}`, { force: true });
      fs.writeFileSync(`${LOG}.${args[1]}`, '');
    }
    process.exit(0);
  }
  process.stderr.write(`fake-claude: unsupported command ${args.join(' ')}\n`);
  process.exit(1);
}
// the user-scope MCP servers `claude mcp add|remove` keep (a file next to the log), which mcp_status reports as connected
const mcpFile = LOG ? `${LOG}.mcp.json` : null;
const mcpNames = () => {
  try {
    return JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  } catch {
    return [];
  }
};
if (args[0] === 'mcp') {
  log({ kind: 'argv', argv: args });
  const name = args.find((a, i) => i > 1 && !a.startsWith('-') && !/^(user|stdio|http|sse)$/.test(a)) ?? '';
  if (mcpFile)
    fs.writeFileSync(
      mcpFile,
      JSON.stringify(args[1] === 'remove' ? mcpNames().filter((n) => n !== name) : [...new Set([...mcpNames(), name])]),
    );
  process.stdout.write(
    args[1] === 'remove' ? `Removed MCP server ${name} from user config\n` : `Added MCP server ${name} to user config\n`,
  );
  process.exit(0);
}
if ((args[0] === '-p' || args[0] === '--print') && flag('--input-format') !== 'stream-json') {
  // the app's login check: `claude -p hi --model haiku --max-turns 1 --no-session-persistence`
  log({ kind: 'argv', argv: args });
  process.stdout.write(SIGNED_IN ? 'fake-claude: hi\n' : 'Invalid API key · Please run /login\n');
  process.exit(SIGNED_IN ? 0 : 1);
}
if (flag('--input-format') !== 'stream-json' || flag('--output-format') !== 'stream-json') {
  process.stderr.write(`fake-claude: unsupported command ${args.join(' ')}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* stream-json session                                                 */
/* ------------------------------------------------------------------ */
log({
  kind: 'argv',
  argv: args,
  cwd: process.cwd(),
  configDir: CONFIG_DIR,
  billing: { key: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), baseUrl: process.env.ANTHROPIC_BASE_URL ?? null },
  cloudEnv: cloudEnvOf(),
});

const MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Fake Opus' },
  {
    value: 'opus',
    displayName: 'Fake Opus',
    description: 'A scripted model for tests',
    resolvedModel: 'claude-fake-opus',
    supportedEffortLevels: ['low', 'medium', 'high'],
    supportsEffort: true,
    supportsFastMode: false,
    supportsAutoMode: true,
  },
  {
    value: 'sonnet',
    displayName: 'Fake Sonnet',
    description: 'A scripted model for tests',
    resolvedModel: 'claude-fake-sonnet',
    supportedEffortLevels: ['low', 'medium', 'high'],
    supportsEffort: true,
    supportsFastMode: false,
    supportsAutoMode: true,
  },
  { value: 'haiku', displayName: 'Fake Haiku', description: 'A scripted model for tests', resolvedModel: 'claude-fake-haiku' },
  ...extraClaudeModels(),
];
const COMMANDS = [
  { name: 'goal', description: 'Set a goal for Claude to keep working toward', argumentHint: '<condition>' },
  { name: 'code-review', description: 'Review the current changes', argumentHint: '[low|medium|high]', aliases: ['review'] },
  { name: 'doctor', description: 'Diagnose the installation (terminal only)', argumentHint: '' },
  { name: 'init', description: 'Initialize a CLAUDE.md file', argumentHint: '' },
  { name: 'compact', description: 'Clear history but keep a summary in context', argumentHint: '' },
  { name: 'usage', description: 'Show plan usage limits', argumentHint: '' },
];
const SKILLS = ['fake-skill'];
// skills show up as commands too, as in the real CLI
COMMANDS.push({ name: 'fake-skill', description: 'A skill the fake knows', argumentHint: '' });
const ACCOUNT = SIGNED_IN
  ? { email: EMAIL, organization: 'Fake Org', subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' }
  : {};
const resumeId = typeof flag('--resume') === 'string' ? flag('--resume') : null;
const sessionId =
  (flag('--fork-session') ? null : resumeId) ?? (typeof flag('--session-id') === 'string' ? flag('--session-id') : randomUUID());
const persist = !flag('--no-session-persistence');
holdStart(!!(flag('--session-id') || flag('--resume'))); // a chat's CLI may start slowly (fake-turn-details.mjs)
let model = typeof flag('--model') === 'string' ? flag('--model') : 'opus';
let permissionMode = typeof flag('--permission-mode') === 'string' ? flag('--permission-mode') : 'default';
const allowedTools = typeof flag('--allowedTools') === 'string' ? flag('--allowedTools').split(',') : [];
/** Names of the SDK's in-process MCP servers, from the initialize control request. */
let sdkServers = [];
const resolvedModel = () => MODELS.find((m) => m.value === model)?.resolvedModel ?? model;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* transcript ------------------------------------------------------- */
const configDir = CONFIG_DIR;
const projectDir = path.join(configDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
/** Where a session's transcript lives: wherever it already is, else under this cwd's folder. */
function transcriptFile(id) {
  try {
    for (const d of fs.readdirSync(path.join(configDir, 'projects'))) {
      const f = path.join(configDir, 'projects', d, `${id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* no projects directory yet means no transcript */
  }
  return path.join(projectDir, `${id}.jsonl`);
}
const transcript = transcriptFile(sessionId);
/** uuid of the newest record in the chain, so appended records continue it (like a resumed CLI). */
let parentUuid = null;
const source = resumeId ? transcriptFile(resumeId) : transcript;
// like the real CLI, a resume of a session with no transcript fails (opt-in: FAKE_CLAUDE_STRICT_RESUME=1)
if (resumeId && !flag('--fork-session') && process.env.FAKE_CLAUDE_STRICT_RESUME === '1' && !fs.existsSync(source)) {
  process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
  process.exit(1);
}
try {
  for (const line of fs.readFileSync(source, 'utf8').split('\n')) {
    try {
      const r = JSON.parse(line);
      if (r.uuid && (r.type === 'user' || r.type === 'assistant')) parentUuid = r.uuid;
    } catch {
      /* skip a partial or non-JSON line */
    }
  }
} catch {
  /* no source transcript: start without a parent */
}
// --resume-session-at: the conversation goes on from that entry (an edited message's branch)
if (typeof flag('--resume-session-at') === 'string') parentUuid = flag('--resume-session-at');
const CHECKPOINTS = process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING === 'true';
/** With checkpointing on, each prompt gets a file-history snapshot under its uuid, as the CLI writes it. */
function snapshot(messageId) {
  if (!CHECKPOINTS || !persist) return;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      type: 'file-history-snapshot',
      messageId,
      snapshot: { messageId, trackedFileBackups: {}, timestamp: new Date().toISOString() },
      isSnapshotUpdate: false,
    }) + '\n',
  );
}

function record(type, extra) {
  if (!persist) return;
  const r = {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: process.cwd(),
    sessionId,
    version: VERSION,
    gitBranch: '',
    type,
    ...extra,
    timestamp: new Date().toISOString(),
  };
  parentUuid = r.uuid;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, JSON.stringify(r) + '\n');
}

/* turns ------------------------------------------------------------ */
/** User messages waiting for their turn; the CLI runs them one at a time. */
const queue = [];
let running = false;
let interrupted = null; // resolves the SLOW turn waiting on an interrupt
let closed = false;

/** The app's chat-title helper prompt (shared/title.mjs titlePrompt). */
const TITLE_HELPER = /^Summarize the request below as a short chat title\b/;

function replyFor(text) {
  // the title helper gets a short fixed title instead of an echo
  if (TITLE_HELPER.test(text)) return 'Fake chat title';
  if (text.trim() === '/usage') return fakeClaudeUsage(Date.now(), USAGE_FULL);
  return fakeMomoReply(withoutMomoContext(text)) ?? `fake-claude: ${withoutMomoContext(text)}`;
}

function init() {
  send({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'],
    mcp_servers: [],
    model: resolvedModel(),
    permissionMode,
    slash_commands: COMMANDS.map((c) => c.name),
    terminal_slash_commands: ['doctor'],
    apiKeySource: 'none',
    claude_code_version: VERSION,
    output_style: 'default',
    agents: [],
    skills: SKILLS,
    plugins: [],
    uuid: randomUUID(),
  });
}

/* goals ------------------------------------------------------------ */
/** The session's goal condition, or null. A crashed process leaves it in a file the reopened session reads. */
const goalFile = path.join(CONFIG_DIR, `.fake-goal-${sessionId}`);
const setGoal = (v) => {
  goal = v;
  if (v === null) fs.rmSync(goalFile, { force: true });
};
let goal = fs.existsSync(goalFile) ? fs.readFileSync(goalFile, 'utf8') : null;

function result(started, stopped, text, usage) {
  send({
    type: 'result',
    subtype: stopped ? 'error_during_execution' : 'success',
    is_error: stopped,
    duration_ms: Date.now() - started,
    duration_api_ms: Date.now() - started,
    num_turns: 1,
    ...(stopped ? { errors: [] } : { result: text }),
    stop_reason: 'end_turn',
    session_id: sessionId,
    total_cost_usd: 0,
    usage,
    modelUsage: {
      [resolvedModel()]: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200000,
        maxOutputTokens: 32000,
      },
    },
    permission_denials: [],
    uuid: randomUUID(),
  });
}

/** Out of usage, or a lapsed token (".fake-expired" in the login folder): the CLI's error reply and a failed result. */
const limitReached = (started) => refusedTurn({ send, record, sessionId }, started, 'limit');
const authFailed = (started) => refusedTurn({ send, record, sessionId }, started, 'expired');
const expired = () => fs.existsSync(path.join(CONFIG_DIR, '.fake-expired'));

async function runGoal(msg, args, started) {
  const base = { parent_tool_use_id: null, session_id: sessionId };
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const local = (content) => {
    record('system', { subtype: 'local_command', content: `<local-command-stdout>${content}</local-command-stdout>`, uuid: randomUUID() });
    send({ type: 'system', subtype: 'local_command_output', content, ...base, uuid: randomUUID() });
    result(started, false, '', usage);
  };
  if (!args) return local(goal ? `Goal active: ${goal}` : 'No goal set');
  if (args === 'clear') {
    const was = goal;
    setGoal(null);
    return local(was ? `Goal cleared: ${was}` : 'No goal set');
  }
  goal = args;
  const synthetic = (text) => {
    const message = {
      id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    };
    const uuid = randomUUID();
    record('assistant', { message, uuid });
    send({ type: 'assistant', message, ...base, uuid });
  };
  const status = (met, reason) =>
    record('attachment', { attachment: { type: 'goal_status', met, condition: args, reason }, uuid: randomUUID() });
  const feedback = (reason) => {
    const content = [{ type: 'text', text: `Stop hook feedback:\n[${args}]: ${reason}` }];
    const uuid = randomUUID();
    record('user', { message: { role: 'user', content }, isMeta: true, uuid });
    send({ type: 'user', message: { role: 'user', content }, isSynthetic: true, ...base, uuid });
  };
  synthetic(`Goal set: ${args}`);
  // the goal stays set; the first round needs a model call this login can't make
  if (LIMITED || expired()) return (LIMITED ? limitReached : authFailed)(started);
  let stopped = false;
  const stop = new Promise((resolve) => (interrupted = resolve)).then(() => (stopped = true));
  for (let round = 1; !stopped && (args.includes('SLOW') || round <= 2); round++) {
    await Promise.race([sleep(args.includes('SLOW') ? 150 : STEP_MS * 4), stop]);
    if (stopped) break;
    synthetic(`fake-claude: working on ${args} (round ${round})`);
    status(false, `round ${round} not done yet`);
    feedback(`round ${round} not done yet`);
    // once per session: the reopened one runs the goal to its end
    if (args.includes('CRASH') && !fs.existsSync(`${goalFile}.crashed`)) {
      fs.writeFileSync(goalFile, args);
      fs.writeFileSync(`${goalFile}.crashed`, '');
      process.exit(137);
    }
  }
  interrupted = null;
  if (stopped) {
    record('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, uuid: randomUUID() });
  } else {
    synthetic(`fake-claude: done with ${args}`);
    status(true, 'the condition holds');
    setGoal(null);
  }
  result(started, stopped, '', usage);
}

/* MCP through the SDK ---------------------------------------------- */
/** Control requests the fake sends the SDK: request_id -> resolve(response) */
const askedSdk = new Map();
let nextAsk = 1;
function askSdk(request) {
  const request_id = `fake-cli-${nextAsk++}`;
  send({ type: 'control_request', request_id, request });
  return new Promise((resolve) => askedSdk.set(request_id, resolve));
}

const { permit, callSdkMcp, callSdkTool, wrapUpWake } = createFakeClaudeTools({
  version: VERSION,
  sessionId,
  allowedTools,
  askSdk,
  send,
  log,
  record,
  resolvedModel,
  state: {
    get permissionMode() {
      return permissionMode;
    },
    get sdkServers() {
      return sdkServers;
    },
  },
});
const { runReview } = createFakeClaudeReview({ sessionId, send, log, record, resolvedModel, result, sleep, stepMs: STEP_MS });
const cli = { sessionId, configDir: CONFIG_DIR, logFile: LOG, send, record, result, log, toolRound, authFailed, sleep };
const { trouble } = createFakeClaudeTrouble({ ...cli, onInterrupt: (fn) => (interrupted = fn) });

/**
 * A tool call the way the CLI makes one: the tool_use, the permission check (a card in the app unless
 * the mode allows it), then the tool_result. `run` does the work once allowed and may give back the
 * structured result; a refused call ends in the CLI's "doesn't want to proceed" error. Returns 'allow' or 'deny'.
 */
async function toolRound(name, input, run) {
  const base = { parent_tool_use_id: null, session_id: sessionId };
  const id = `toolu_fake_${randomUUID().slice(0, 8)}`;
  const message = {
    id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type: 'message',
    role: 'assistant',
    model: resolvedModel(),
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  let uuid = randomUUID();
  record('assistant', { message, uuid });
  send({ type: 'assistant', message, ...base, uuid });
  const decision = await permit(name, input);
  const out = decision === 'allow' ? ((await run?.(id)) ?? {}) : null;
  const content = [
    {
      type: 'tool_result',
      tool_use_id: id,
      content: out ? (out.text ?? 'ok') : "The user doesn't want to proceed with this tool use. The tool use was rejected",
      ...(out && !out.isError ? {} : { is_error: true }),
    },
  ];
  uuid = randomUUID();
  record('user', { message: { role: 'user', content }, uuid });
  send({
    type: 'user',
    message: { role: 'user', content },
    ...base,
    uuid,
    ...(out?.structured != null ? { tool_use_result: out.structured } : {}),
  });
  return decision;
}

/** Output of the foreground commands still running (RUNCMDSTREAM): task_id -> text */
const shellOut = new Map();
async function runStreaming(toolUseId) {
  const taskId = `bfake${randomUUID().slice(0, 6)}`;
  send({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: 'npm test',
    task_type: 'local_bash',
    is_backgrounded: false,
    session_id: sessionId,
    uuid: randomUUID(),
  });
  shellOut.set(taskId, '');
  for (const line of ['running suite A\n', 'running suite B\n']) {
    await sleep(STEP_MS * 3);
    shellOut.set(taskId, shellOut.get(taskId) + line);
  }
  const release = `${LOG}.release`;
  while (LOG && !fs.existsSync(release)) await sleep(50);
  const text = shellOut.get(taskId) + 'all passed\n';
  shellOut.delete(taskId);
  send({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: toolUseId,
    status: 'completed',
    output_file: '',
    summary: 'npm test completed',
    session_id: sessionId,
    uuid: randomUUID(),
  });
  return { text, structured: { stdout: text, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } };
}

/** Mode changes are announced the way the CLI does: a system/status with the new mode. */
function setMode(mode) {
  permissionMode = mode;
  send({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId, uuid: randomUUID() });
}

/**
 * Plan mode: the plan is saved under $CLAUDE_CONFIG_DIR/plans, then ExitPlanMode asks to leave plan
 * mode with {plan, planFilePath}. An approval's setMode applies; without one the CLI goes back to
 * its own pre-plan mode ('default' for a session started in plan). The answer is logged as {kind: 'plan'}.
 */
async function presentPlan(text) {
  const base = { parent_tool_use_id: null, session_id: sessionId };
  const plan = `1. Look at the request: ${text}\n2. Make the change.\n`;
  const planFilePath = path.join(configDir, 'plans', 'fake-plan.md');
  fs.mkdirSync(path.dirname(planFilePath), { recursive: true });
  fs.writeFileSync(planFilePath, plan);
  const id = `toolu_fake_${randomUUID().slice(0, 8)}`;
  const message = {
    id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type: 'message',
    role: 'assistant',
    model: resolvedModel(),
    content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan, planFilePath } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  let uuid = randomUUID();
  record('assistant', { message, uuid });
  send({ type: 'assistant', message, ...base, uuid });
  const r =
    (
      await askSdk({
        subtype: 'can_use_tool',
        tool_name: 'ExitPlanMode',
        input: { plan, planFilePath },
        tool_use_id: id,
        permission_suggestions: [],
      })
    )?.response ?? {};
  log({ kind: 'plan', response: r });
  const approved = r.behavior === 'allow';
  if (approved) setMode(r.updatedPermissions?.find((u) => u.type === 'setMode')?.mode ?? 'default');
  const content = [
    {
      type: 'tool_result',
      tool_use_id: id,
      content: approved ? `User has approved your plan.\n\n## Approved Plan:\n${plan}` : (r.message ?? 'The user rejected the plan.'),
      ...(approved ? {} : { is_error: true }),
    },
  ];
  uuid = randomUUID();
  record('user', { message: { role: 'user', content }, uuid });
  send({
    type: 'user',
    message: { role: 'user', content },
    ...base,
    uuid,
    ...(approved ? { tool_use_result: { plan, isAgent: false, filePath: planFilePath } } : {}),
  });
  return approved ? ` [plan approved, now ${permissionMode}]` : ' [plan rejected]';
}

/* background tasks ---------------------------------------------- */
let perTaskStop = false;
let ultracode = false;
/** Live background tasks: task_id -> {description, toolUseId} */
const tasks = new Map();
const level = () =>
  send({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [...tasks].map(([task_id, t]) => ({
      task_id,
      task_type: t.type ?? 'local_agent',
      subagent_type: t.type ? undefined : 'general-purpose',
      description: t.description,
      parent_task_id: t.parent,
    })),
    session_id: sessionId,
    uuid: randomUUID(),
  });
function endTask(id, status) {
  const t = tasks.get(id);
  if (!t) return;
  tasks.delete(id);
  send({
    type: 'system',
    subtype: 'task_updated',
    task_id: id,
    patch: { status: status === 'stopped' ? 'killed' : status },
    session_id: sessionId,
    uuid: randomUUID(),
  });
  send({
    type: 'system',
    subtype: 'task_notification',
    task_id: id,
    tool_use_id: t.toolUseId,
    status,
    output_file: '',
    summary: `${t.description} ${status}`,
    session_id: sessionId,
    uuid: randomUUID(),
  });
  level();
  log({ kind: 'task', id, status });
}

/**
 * "BGTASK <what>": an Agent tool call that runs in the background. Its sub-agent reports a step
 * and a progress summary, then keeps running until stop_task (or an interrupt without the
 * perTaskStopAffordance declaration) ends it.
 */
function startBackgroundAgent(what) {
  const base = { session_id: sessionId };
  const toolUseId = `toolu_fake_${randomUUID().slice(0, 8)}`;
  const id = `task_${randomUUID().slice(0, 6)}`;
  const description = `Explore ${what}`;
  const message = {
    id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type: 'message',
    role: 'assistant',
    model: resolvedModel(),
    content: [
      { type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, prompt: `look at ${what}`, run_in_background: true } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  send({ type: 'assistant', message, parent_tool_use_id: null, ...base, uuid: randomUUID() });
  tasks.set(id, { description, toolUseId });
  level();
  send({
    type: 'system',
    subtype: 'task_started',
    task_id: id,
    tool_use_id: toolUseId,
    description,
    task_type: 'local_agent',
    subagent_type: 'general-purpose',
    is_backgrounded: true,
    ...base,
    uuid: randomUUID(),
  });
  const sub = {
    id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type: 'message',
    role: 'assistant',
    model: resolvedModel(),
    content: [
      { type: 'tool_use', id: `toolu_fake_${randomUUID().slice(0, 8)}`, name: 'Read', input: { file_path: `${process.cwd()}/README.md` } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  send({ type: 'assistant', message: sub, parent_tool_use_id: toolUseId, ...base, uuid: randomUUID() });
  send({
    type: 'system',
    subtype: 'task_progress',
    task_id: id,
    tool_use_id: toolUseId,
    description,
    usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
    last_tool_name: 'Read',
    summary: `Reading ${what}`,
    ...base,
    uuid: randomUUID(),
  });
  const content = [{ type: 'tool_result', tool_use_id: toolUseId, content: `Async agent launched (${id})` }];
  send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...base, uuid: randomUUID() });
}

/** "BGWORKFLOW <name>": a background workflow with two sub-agent tasks under it, at a stage. */
function startBackgroundWorkflow(name) {
  const base = { session_id: sessionId };
  const id = `task_${randomUUID().slice(0, 6)}`;
  const description = `Run the ${name} workflow`;
  tasks.set(id, { description, type: 'local_workflow' });
  for (const n of [1, 2]) tasks.set(`${id}_a${n}`, { description: `Check part ${n}`, parent: id });
  level();
  send({
    type: 'system',
    subtype: 'task_started',
    task_id: id,
    description,
    task_type: 'local_workflow',
    workflow_name: name,
    is_backgrounded: true,
    ...base,
    uuid: randomUUID(),
  });
  send({
    type: 'system',
    subtype: 'task_progress',
    task_id: id,
    description,
    usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
    summary: 'Stage 2 of 3',
    ...base,
    uuid: randomUUID(),
  });
}

async function runTurn(msg) {
  const original = textOf(msg.message?.content);
  const text = fakeControlText(original, msg.origin?.kind === 'human' ? 'human' : 'nonhuman');
  const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [{ type: 'text', text }];
  const last = blocks.at(-1);
  const review = last?.type === 'text' ? /^\/(?:code-review|review)(?:\s+([\s\S]*))?$/.exec(last.text.trim()) : null;
  if (review) {
    record('user', { message: { role: 'user', content: msg.message?.content ?? '' }, uuid: msg.uuid || randomUUID() });
    init();
    return runReview(msg, (review[1] ?? '').trim(), Date.now());
  }
  if (runLocalCommand(msg, { log, init, send, result, sessionId, uuid: randomUUID })) return;
  const goalCmd = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (goalCmd) {
    snapshot(msg.uuid),
      record('user', {
        message: { role: 'user', content: msg.message?.content ?? '' },
        uuid: msg.uuid || randomUUID(),
        ...(msg.origin ? { origin: msg.origin } : {}),
      });
    init();
    return runGoal(msg, (goalCmd[1] ?? '').trim(), Date.now());
  }
  const started = Date.now();
  snapshot(msg.uuid),
    record('user', {
      message: { role: 'user', content: msg.message?.content ?? '' },
      uuid: msg.uuid || randomUUID(),
      ...(msg.origin ? { origin: msg.origin } : {}),
    });
  init(), log({ kind: 'turn', text: original, model: resolvedModel(), mode: permissionMode, pid: process.pid }); // the model, mode and process each turn ran on
  if (LIMITED && !TITLE_HELPER.test(text) && text.trim() !== '/usage') return limitReached(started);
  if (expired() && !TITLE_HELPER.test(text)) return authFailed(started);
  let reply = replyFor(original);
  const extra = TITLE_HELPER.test(text) ? '' : await trouble(text, started);
  if (extra === null) return;
  reply += extra;
  const mcpCall = /MCPCALL (\S+)/.exec(text);
  if (mcpCall) reply += await callSdkMcp(mcpCall[1]);
  // a message made of several "CUCALL ..." lines runs each, in order, in this turn; otherwise the first CUCALL in it
  const cuCalls = cuCallsOf(text);
  // CUSTEPS: the calls show as tool calls, and an interrupt ends the turn at once
  const steps = text.includes('CUSTEPS') && cuCalls.length > 0;
  let cutShort = false;
  const cut = steps ? new Promise((resolve) => (interrupted = resolve)).then(() => (cutShort = true)) : null;
  for (const cuCall of cuCalls) {
    if (cutShort) break;
    reply += await callSdkTool(cuCall[1], JSON.parse(cuCall[2]), null, { step: steps, cut });
  }
  if (steps && !cutShort) interrupted = null;
  const subCall = /SUBCUCALL (\S+) (\{.*\})/.exec(text);
  if (subCall) reply += await callSdkTool(subCall[1], JSON.parse(subCall[2]), 'toolu_fake_agent');
  reply += await wrapUpWake(original);
  if (text.includes('MCPREPO')) {
    const permission = await permit('mcp__sage__sage_debug_echo', { text: 'repo' }, { name: 'sage', source: 'projectSettings' });
    log({ kind: 'mcp', server: 'sage', permission });
    reply += ` [repo sage: ${permission}]`;
  }
  if (permissionMode === 'plan' && text.includes('PLAN')) reply += await presentPlan(text);
  // the app's title helper sees the prompt too; it doesn't act on it
  const helper = TITLE_HELPER.test(text);
  if (!helper && text.includes('CMDCHANGE')) {
    // a skill found while working: the whole list again, to replace the old one
    COMMANDS.push({ name: 'found-skill', description: 'Found while working', argumentHint: '' });
    send({ type: 'system', subtype: 'commands_changed', commands: COMMANDS, session_id: sessionId, uuid: randomUUID() });
  }
  if (!helper) reply += await askTheApp(text, { askSdk, log });
  // RUNCMD: Bash `npm test`; EDITFILE: writes hello.txt in the chat's folder. Each asks as the CLI would
  // (unless the mode allows it) and the decision goes in the reply as [command: ...] / [edit: ...].
  // RUNCMDFAIL: the command exits 3 (is_error, "Exit code 3" text, a string tool_use_result as the CLI reports it);
  // RUNCMDTIMEOUT: it fails with no exit code in the text
  if (!helper && text.includes('RUNCMDFAIL'))
    reply += ` [command: ${(await toolRound('Bash', { command: 'npm test' }, () => ({ text: 'Exit code 3\n2 failing', isError: true, structured: 'Error: Exit code 3\n2 failing' }))) === 'allow' ? 'ran' : 'declined'}]`;
  // RUNCMDSTREAM: a foreground command that is still running: task_started, then output that grows (get_task_output returns it) until
  // the test writes "$FAKE_CLAUDE_LOG.release"; FAKE_CLAUDE_NO_TASK_OUTPUT=1 answers get_task_output with an error, as a CLI without it
  if (!helper && text.includes('RUNCMDSTREAM'))
    reply += ` [command: ${(await toolRound('Bash', { command: text.includes('LOOP') ? 'for i in 1 2 3; do npm test && break; sleep 1; done' : 'npm test' }, (toolUseId) => runStreaming(toolUseId))) === 'allow' ? 'ran' : 'declined'}]`;
  if (!helper) await scriptedToolTurns(text, toolRound, { send, sessionId, log: LOG }); // FGTASK, LABELCHURN
  if (!helper && text.includes('RUNCMDTIMEOUT'))
    reply += ` [command: ${(await toolRound('Bash', { command: 'npm test' }, () => ({ text: 'Command timed out after 120s', isError: true, structured: 'Error: Command timed out after 120s' }))) === 'allow' ? 'ran' : 'declined'}]`;
  if (!helper && /RUNCMD(?![A-Z])/.test(text))
    reply += ` [command: ${(await toolRound('Bash', { command: 'npm test' }, () => ({ text: 'tests passed', structured: { stdout: 'tests passed', stderr: '' } }))) === 'allow' ? 'ran' : 'declined'}]`;
  if (!helper && text.includes('AFTERTOOLHOLD')) await released(LOG); // thinks on after its tools until "$LOG.release"
  if (!helper && text.includes('EDITFILE')) {
    const file = path.join(process.cwd(), 'hello.txt');
    const d = await toolRound(
      'Write',
      { file_path: file, content: 'hello\nworld\n' },
      () => (
        fs.writeFileSync(file, 'hello\nworld\n'),
        {
          text: `File created successfully at: ${file}`,
          structured: { type: 'create', filePath: file, content: 'hello\nworld\n', structuredPatch: [] },
        }
      ),
    );
    reply += ` [edit: ${d === 'allow' ? 'written' : 'declined'}]`;
  }
  // HOOKOK / HOOKFAIL: a hook that passed, one that failed (fake-turn-details.mjs)
  if (!helper) for (const m of claudeHookResponses(text)) send({ ...m, session_id: sessionId, uuid: randomUUID() });
  const bg = /BGTASK (\S+)/.exec(text);
  if (bg) startBackgroundAgent(bg[1]);
  const wf = /BGWORKFLOW (\S+)/.exec(text);
  if (wf) startBackgroundWorkflow(wf[1]);
  const msgId = `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const base = { parent_tool_use_id: null, session_id: sessionId };
  const event = (e) => send({ type: 'stream_event', event: e, ...base, uuid: randomUUID() });
  const usage = claudeUsage(original, reply);
  event({
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: resolvedModel(),
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  // THINK / THINKTWICE: thinking blocks ahead of the text, which takes the next index
  const at = helper
    ? 0
    : await streamClaudeThoughts(text, {
        event,
        sleep,
        send: (m) => send({ ...m, ...base, uuid: randomUUID() }),
        message: { id: msgId, model: resolvedModel(), usage },
      });
  event({ type: 'content_block_start', index: at, content_block: { type: 'text', text: '' } });
  // a handoff record quotes the earlier conversation; only what the user typed makes a turn slow
  const slow = text.replace(/<sage-handoff[\s\S]*?<\/sage-handoff>/, '').includes('SLOW');
  for (const delta of slow ? [reply] : reply.match(/.{1,8}/gs) || ['']) {
    await sleep(STEP_MS);
    event({ type: 'content_block_delta', index: at, delta: { type: 'text_delta', text: delta } });
  }
  // a test held this turn (not a command the app sends on its own, such as /usage)
  if (!helper && !text.startsWith('/') && heldNext(LOG)) await released(LOG);
  let stopped = cutShort;
  if (slow && !stopped) stopped = await new Promise((resolve) => (interrupted = resolve));
  interrupted = null;
  event({ type: 'content_block_stop', index: at });
  event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage });
  event({ type: 'message_stop' });
  const message = {
    id: msgId,
    type: 'message',
    role: 'assistant',
    model: resolvedModel(),
    content: [{ type: 'text', text: reply }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  };
  const uuid = randomUUID();
  record('assistant', { message, requestId: `req_fake_${uuid.slice(0, 8)}`, uuid });
  send({ type: 'assistant', message, ...base, uuid });
  if (stopped)
    record('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, uuid: randomUUID() });
  result(started, stopped, reply, usage);
}
async function drain() {
  if (running) return;
  running = true;
  await drainQueue(queue, runTurn, { send, record, sessionId, textOf });
  running = false;
  if (closed) process.exit(0);
}

/* control requests ------------------------------------------------- */
const control = {
  // the running CLI's own session title (harness/claude/title.cjs asks for it at send, #2150)
  generate_session_title: () => ({ title: 'Fake chat title' }),
  initialize: (r) => {
    sdkServers = r.sdkMcpServers || [];
    perTaskStop = !!r.perTaskStopAffordance;
    return {
      commands: COMMANDS,
      agents: [],
      output_style: 'default',
      available_output_styles: ['default'],
      models: MODELS,
      account: ACCOUNT,
      fast_mode_state: 'off',
      fast_mode_disabled_reason: 'extra_usage_disabled',
      pending_permission_requests: [],
      pending_user_dialog_requests: [],
    };
  },
  interrupt: () => {
    // drop queued prompts, like the CLI does
    queue.length = 0;
    interrupted?.(true);
    // without the per-task stop declaration an interrupt takes background agents with it (C8)
    if (!perTaskStop) for (const id of [...tasks.keys()]) endTask(id, 'stopped');
    return { still_queued: [] };
  },
  set_permission_mode: (r) => {
    setMode(r.mode ?? permissionMode);
    return {};
  },
  set_model: (r) => {
    model = r.model ?? 'opus';
    return {};
  },
  rename_session: (r) => renameSession({ transcript, sessionId, persist }, r),
  mcp_status: () => ({ mcpServers: mcpNames().map((name) => ({ name, status: 'connected', scope: 'user' })) }),
  rewind_files: (r) => {
    log({ kind: 'rewind', uuid: r.user_message_id, dryRun: !!r.dry_run });
    return { canRewind: true, filesChanged: [path.join(process.cwd(), 'notes.txt')], insertions: 1, deletions: 0 };
  },
  stop_task: (r) => {
    endTask(r.task_id, 'stopped');
    return {};
  },
  get_task_output: (r) => {
    if (process.env.FAKE_CLAUDE_NO_TASK_OUTPUT) throw new Error('Unknown control request subtype: get_task_output');
    const output = shellOut.get(r.task_id) ?? '';
    return { output, total_bytes: Buffer.byteLength(output), truncated: false };
  },
  get_settings: () => ({
    applied: { model: resolvedModel(), effort: 'medium', ultracode, ultracodeRequested: ultracode, ultracodeAvailable: true },
  }),
  apply_flag_settings: (r) => {
    const st = r.settings ?? {};
    // as the CLI does (C6): an effort change without ultracode turns it off
    if ('ultracode' in st) ultracode = !!st.ultracode;
    else if ('effortLevel' in st) ultracode = false;
    return {};
  },
};

function handle(msg) {
  if (msg.type === 'control_request') {
    const fn = control[msg.request?.subtype] ?? { remote_control: remoteControl }[msg.request?.subtype];
    // anything not scripted succeeds with an empty response, so the app never hangs on it
    try {
      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: fn ? fn(msg.request) : {} } });
    } catch (e) {
      send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: String(e?.message || e) } });
    }
    return;
  }
  if (msg.type === 'user') {
    queue.push(msg);
    drain();
  }
  if (msg.type === 'control_response') {
    const resolve = askedSdk.get(msg.response?.request_id);
    askedSdk.delete(msg.response?.request_id);
    resolve?.(msg.response);
    return;
  }
  // keep_alive and the rest need no answer
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log({ kind: 'in', msg });
  handle(msg);
});
rl.on('close', () => {
  closed = true;
  if (!running) process.exit(0);
});
