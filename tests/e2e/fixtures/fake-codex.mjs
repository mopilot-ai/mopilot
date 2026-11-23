#!/usr/bin/env node
// A scripted stand-in for `codex` used by the e2e tests. `fake-codex app-server` speaks the
// app-server's newline-delimited JSON-RPC over stdio with just enough behavior for the app's
// startup and the CUJ tests. Every request is appended to $FAKE_CODEX_LOG (JSONL) so tests can
// assert on what the app sent. Replies are deterministic: "fake-codex: <user text>". A prompt
// containing "SLOW" streams one delta (none with "HOLDREPLY": its steps stay the thread's last rows) and then waits until it is interrupted (or completes once the
// file $FAKE_CODEX_LOG.release appears, which it then removes); one containing
// "THINK" streams a reasoning summary before the reply; one containing "TOOLCALL <word>" first sends
// the client an item/tool/call request for sage_debug_echo (plus an attestation/generate the client
// should refuse) and puts the tool's answer in the reply; one containing "CRASH" asks for a command
// approval and then exits mid-turn; quitting as it starts or mid-session, and rollout files: fake-codex-down.mjs. Threads are saved next to the log, so a fake
// started again after a crash has them. Responses to those requests are logged too.
// Sign-in, usage limits and lapsed tokens (FAKE_CODEX_AUTH, USAGELIMIT, AUTHEXPIRED): fake-codex-accounts.mjs.
// FAKE_CODEX_USAGE=1 reports usage in account/rateLimits/read (42% of 5h, 10% of weekly).
// THINKTWICE, ASKASYNC, HOOKOK / HOOKFAIL, CTXUSE, a held next turn and the review's findings format: fake-turn-details.mjs.
// plugin/list has one plugin (Notes Helper) that plugin/install and plugin/uninstall flip; skills/list has one personal skill.
// config/value/write keeps mcp_servers in memory (config/read and mcpServerStatus/list show them); config/read's features follow the home's [features].
// externalAgentConfig/detect offers Claude Code's CLAUDE.md until externalAgentConfig/import has run.
// A message sent while a SLOW turn runs (turn/steer) joins that turn: its MCPCU lines run, it gets a reply of its own and the turn completes
// right behind the steer's answer. A steer for a turn that is not running is refused, as the app-server does.
// A goal objective with FINISH is met in its third round (see the goal rounds below).
// "APPROVECMD" runs `npm test` after a command approval, "EDITFILE" writes hello.txt in the chat's folder after a
// file-change approval; the decision comes back in the reply as [command: ran|declined] / [edit: written|declined].
// "CUCALL <tool> <json args>" sends an item/tool/call for that computer-use tool (waiting up to a
// minute, as a card may be up) and puts the answer in the reply as [cu: ...]; a message made of several CUCALL
// lines runs each, in order, in the same turn (the in-app browser closes an agent's tab when its turn ends). A goal whose objective
// contains "CONTINUE" runs a second round by itself after the first, as a goal continues with nobody
// asking; CUCALL in such an objective runs only in that second round.
// CUSTEPS additionally records native dynamicToolCall items for CUCALL, including input images (fake-codex-dynamic.mjs).
// The stdio MCP servers in a thread's config.mcp_servers (thread/start, thread/resume) are launched
// as the real app-server launches them, as its own children; a prompt containing "MCPCALL <word>"
// calls sage_debug_echo on each and puts the answers in the reply. A prompt made of "MCPCU <tool> <json args>" lines
// calls each of those tools, in order, on the thread's sage_<nonce> server (MoPilot's host tools, e.g.
// desktop_app_click): each is an mcpToolCall item of the turn, its answer goes in the reply as [cu: ...] (images as
// <image>), and an interrupt ends the turn at once, leaving the call in flight unanswered. As in Codex, a call fails with
// "requires approval" unless the server sets default_tools_approval_mode "approve" or the tool is
// readOnlyHint. Each MCP call's outcome is logged as {kind: 'mcp'}. Goals are kept per
// thread; setting an active goal starts a scripted turn on the objective, with no user message,
// as the real app-server does, and so does resuming a thread whose goal is active. A turn sent in
// plan mode answers with a plan (a plan item when the prompt says PLANITEM, otherwise only a
// message, as the luna models do) and reports the mode change with thread/settings/updated.
// review/start runs an inline review, and thread/compact/start a turn holding only a compaction.
// Model one has Fast (the "priority" service tier); model two has the "ultra" effort. thread/fork
// copies the turns through lastTurnId and carries the goal along. A prompt with BGTERM leaves
// "sleep 300" running as a background terminal (thread/backgroundTerminals/*, osPid unknown), ending on its own
// after n seconds with "BGTERM <n>s"; one with SPAWN spawns a sub-agent whose thread has a finished turn of its own. A seeded
// thread with `elsewhere` or `rollout` is written by another client too (fake-codex-elsewhere.mjs). Provider trouble
// (PROVIDERRETRY, LOGINEXPIRED): fake-codex-trouble.mjs.
// Projects start from $FAKE_CODEX_PROJECTS (JSON: [{ name, path }]), and threads from
// $FAKE_CODEX_THREADS (JSON: [{ id, name?, cwd?, archived?, turns: [user text | { text, items }], goal?: { objective, status }, elsewhere?, rollout? }]).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createFakeCodexMcp } from './fake-codex-mcp.mjs';
import { callDynamicTools, goalRoundOf } from './fake-codex-dynamic.mjs';
import { configOf, configHandlers } from './fake-codex-config.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { refusal } from './fake-codex-refusals.mjs';
import { createFakeCodexAccounts } from './fake-codex-accounts.mjs';
import { relayOf, probeRelay } from './fake-codex-relay.mjs';
import { fakeMomoReply, fakeControlText, fakeTextOf as textOf } from './fake-control-text.mjs';
import { replyNativeRequest } from './prepared-native-gate.cjs';
import { createFakeCodexElsewhere } from './fake-codex-elsewhere.mjs';
import { createFakeCodexTrouble, TROUBLE } from './fake-codex-trouble.mjs';
import { createCrashTurn, createRollouts, startOrQuit, watchQuit } from './fake-codex-down.mjs';
import { codexReviewText, codexTurnEnd, heldNext, streamCodexThoughts } from './fake-turn-details.mjs';
import { withThreadSettings } from './fake-codex-settings.mjs';
import { createFakeCodexHistory } from './fake-codex-history.mjs';

// the tested version unless a test sets another; FAKE_CODEX_MISSING and FAKE_CODEX_FAIL: fake-codex-refusals.mjs
const VERSION = process.env.FAKE_CODEX_VERSION || '0.162.0-alpha.17.2';
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write(`codex-cli ${VERSION}\n`);
  process.exit(0);
}
if (args[0] === 'cloud') {
  if (args[1] === 'list') process.stdout.write(JSON.stringify({ tasks: [] }) + '\n');
  else process.stderr.write('fake-codex: cloud is not supported\n');
  process.exit(args[1] === 'list' ? 0 : 1);
}
if (args[0] !== 'app-server') {
  process.stderr.write(`fake-codex: unsupported command ${args.join(' ')}\n`);
  process.exit(1);
}

const LOG = process.env.FAKE_CODEX_LOG;
const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.HOME || '/tmp', '.codex');
const MODELS = ['fake-model-1', 'fake-model-2'];
const STEP_MS = 15;

const now = () => Math.floor(Date.now() / 1000);
/** Lines held to go out in one write (see turn/steer), or null. */
let held = null;
const send = (msg) => (held ? held.push(JSON.stringify(msg) + '\n') : process.stdout.write(JSON.stringify(msg) + '\n'));
/** What is sent until the next turn of the event loop goes out in a single write, so main reads it as one chunk. */
function oneWrite() {
  if (held) return;
  held = [];
  setImmediate(() => {
    const out = held.join('');
    held = null;
    process.stdout.write(out);
  });
}
const notify = (method, params) => send({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.FAKE_CODEX_START_MS) await sleep(Number(process.env.FAKE_CODEX_START_MS));
function log(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch {
    /* debug log only: a failed write must not break the fake server */
  }
}
if (!startOrQuit({ log, version: VERSION })) watchQuit({ log });

/** id -> { thread, turns, archived, title, goal, running } */
const threads = new Map();
const { elsewhereDone, otherAppTurn } = createFakeCodexElsewhere({ log: LOG, textOf, now, saveState });
/** Codex's own project list (project/*) */
const projects = (() => {
  try {
    return JSON.parse(process.env.FAKE_CODEX_PROJECTS || '[]').map((p, i) => fakeProject(p.name, p.path, i));
  } catch {
    return [];
  }
})();
function fakeProject(name, root, position) {
  const t = now();
  return { id: randomUUID(), name, roots: [{ path: root }], metadata: {}, position, createdAt: t, updatedAt: t, recencyAt: null };
}
function projectChanged(projectId, changeType) {
  setImmediate(() => notify('project/changed', { projectId, changeType }));
}

/* ---------- MCP servers from a thread's config ---------- */
/** turn id -> resolve(), for turns waiting on turn/interrupt */
const waiting = new Map();
const { useMcpConfig, callMcp, callHostTools } = createFakeCodexMcp({ version: VERSION, log, notify, waiting });
/** turn id -> resolve(), for a SLOW turn a steered message finishes */
const steerable = new Map();

/** Server requests sent to the client: id -> resolve(response) */
const asked = new Map();
let nextAsk = 1;
/** Sends the client a request and waits (up to 5s) for its first response. */
function ask(method, params, timeoutMs = 5000) {
  const id = `fake-srv-${nextAsk++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => (asked.delete(id), resolve(null)), timeoutMs);
    asked.set(id, (res) => (clearTimeout(timer), resolve(res)));
    send({ id, method, params });
  });
}

function model(id, isDefault) {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id === MODELS[0] ? 'Fake Model One' : 'Fake Model Two',
    description: 'A scripted model for tests',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'medium', description: 'Medium' },
      ...(id === MODELS[1] ? [{ reasoningEffort: 'ultra', description: 'Several agents' }] : []),
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: false,
    multiAgentVersion: id === MODELS[1] ? 'v2' : null,
    additionalSpeedTiers: [],
    serviceTiers:
      id === MODELS[0]
        ? [
            { id: 'priority', name: 'Fast', description: '1.5x speed, 2x credits' },
            { id: 'flex', name: 'Flex', description: 'Slower, half the credits' },
          ]
        : [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault,
  };
}

function newThread(params) {
  const t = now();
  const thread = {
    id: randomUUID(),
    environments: null,
    extra: null,
    sessionId: randomUUID(),
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: !!params.ephemeral,
    section: null,
    sectionEnteredAt: null,
    projectId: params.projectId ?? null,
    historyMode: 'full',
    modelProvider: 'openai',
    model: params.model ?? MODELS[0],
    reasoningEffort: null,
    createdAt: t,
    updatedAt: t,
    recencyAt: t,
    status: { type: 'idle' },
    path: null,
    cwd: params.cwd || process.env.HOME || '/',
    cliVersion: VERSION,
    originator: 'fake-codex',
    source: 'appServer',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: [],
  };
  // the app's hidden title helper threads get a short fixed title instead of an echo
  const title = /title/i.test(params.developerInstructions || '');
  const rec = { thread, turns: [], archived: false, title };
  threads.set(thread.id, rec);
  return rec;
}

const view = (rec, withTurns = false) => ({ ...rec.thread, turns: withTurns ? rec.turns : [] });

function sessionInfo(rec) {
  return {
    thread: view(rec),
    model: rec.thread.model,
    modelProvider: 'openai',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: rec.thread.cwd,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: 'explicitRequestOnly',
  };
}

/** A scripted turn; `input` null is a goal turn working on `text` without a user message. */
function startTurn(rec, input, clientId, text = textOf(input), run = runTurn) {
  const items = input ? [{ type: 'userMessage', id: randomUUID(), clientId: clientId ?? null, content: input }] : [];
  if (!input) threadSettings.goalRound(rec, run === runTurn);
  const turn = {
    id: randomUUID(),
    items,
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: now(),
    completedAt: null,
    durationMs: null,
  };
  rec.turns.push(turn);
  rec.running = turn.id;
  if (!rec.thread.preview) rec.thread.preview = text;
  setImmediate(() => run(rec, turn, text));
  return turn;
}

/** The thread's collaboration mode changed: say so, as thread/settings/updated. */
function setMode(rec, mode) {
  if (!mode || (rec.mode ?? 'default') === mode.mode) return;
  rec.mode = mode.mode;
  notify('thread/settings/updated', { threadId: rec.thread.id, threadSettings: { model: rec.thread.model, collaborationMode: mode } });
}

/** A turn of items that are already finished: started, each item, completed. */
async function scriptedTurn(rec, turn, items) {
  const threadId = rec.thread.id;
  const turnId = turn.id;
  rec.thread.status = { type: 'active', activeFlags: [] };
  notify('thread/status/changed', { threadId, status: rec.thread.status });
  notify('turn/started', { threadId, turn: { ...turn, items: [] } });
  for (const item of items) {
    await sleep(STEP_MS);
    turn.items.push(item);
    notify('item/started', { item, threadId, turnId, startedAtMs: Date.now() });
    notify('item/completed', { item, threadId, turnId, completedAtMs: Date.now() });
  }
  turn.status = 'completed';
  turn.completedAt = now();
  turn.durationMs = 1;
  rec.thread.status = { type: 'idle' };
  rec.running = null;
  saveState();
  notify('turn/completed', { threadId, turn: { ...turn, items: [...turn.items] } });
  notify('thread/status/changed', { threadId, status: rec.thread.status });
}

function getThread(id) {
  const rec = threads.get(id);
  if (!rec) throw Object.assign(new Error(`thread not found: ${id}`), { code: -32600 });
  return rec;
}

/** Threads that already exist when the app starts, each turn answered and complete. */
function seedThreads() {
  let list = [];
  try {
    list = JSON.parse((process.env.FAKE_CODEX_THREADS || '[]').replace(/^@(.*)$/, (_, f) => fs.readFileSync(f, 'utf8')));
  } catch {
    /* malformed FAKE_CODEX_THREADS: seed no threads */
  }
  list.forEach((s, i) => {
    const rec = newThread({ cwd: s.cwd });
    threads.delete(rec.thread.id);
    Object.assign(rec.thread, {
      id: s.id,
      name: s.name ?? null,
      preview: s.turns?.[0]?.text ?? s.turns?.[0] ?? '',
      updatedAt: rec.thread.updatedAt - i,
      recencyAt: rec.thread.recencyAt - i,
    });
    rec.archived = !!s.archived;
    if (s.elsewhere || s.rollout) {
      // another client's turn as the app-server reads it: interrupted, with no end yet (or a thread it may write)
      rec.elsewhere = !!s.elsewhere;
      rec.thread.path = path.join(CODEX_HOME, 'sessions', `rollout-${s.id}.jsonl`);
      fs.mkdirSync(path.dirname(rec.thread.path), { recursive: true });
      fs.writeFileSync(rec.thread.path, '{}\n');
    }
    if (s.goal)
      rec.goal = {
        threadId: s.id,
        objective: s.goal.objective,
        status: s.goal.status,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now(),
        updatedAt: now(),
      };
    for (const seed of s.turns ?? []) {
      const { text, items, status = 'completed', completedAt = now() } = typeof seed === 'string' ? { text: seed } : seed;
      const user = { type: 'userMessage', id: randomUUID(), clientId: null, content: [{ type: 'text', text, text_elements: [] }] };
      const agent = {
        type: 'agentMessage',
        id: randomUUID(),
        text: `fake-codex: ${text}`,
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      rec.turns.push({
        id: randomUUID(),
        items: items ?? [user, agent],
        itemsView: 'full',
        status,
        error: null,
        startedAt: completedAt,
        completedAt,
        durationMs: 1,
      });
    }
    if (rec.elsewhere) {
      const last = rec.turns.at(-1);
      Object.assign(last, { status: 'interrupted', completedAt: null, durationMs: null, items: last.items.slice(0, 1) });
    }
    threads.set(s.id, rec);
  });
}
/*
 * Threads outlive the process, as the real app-server's rollouts do: a fake started again (after a
 * crash) picks up the threads the one before it had, with any unfinished turn interrupted. One saved state for each CODEX_HOME: MoMo's second app-server has a home of its own.
 */
const STATE = LOG ? `${LOG}.${createHash('sha1').update(CODEX_HOME).digest('hex').slice(0, 8)}.state.json` : null;
const writeRollouts = createRollouts({ codexHome: CODEX_HOME });
function saveState() {
  writeRollouts(threads);
  if (!STATE) return;
  try {
    // write then rename: the app kills this process at quit, and a cut-off write would leave an empty file
    fs.writeFileSync(
      `${STATE}.tmp`,
      JSON.stringify([...threads.values()].map(({ thread, turns, archived, title, goal }) => ({ thread, turns, archived, title, goal }))),
    );
    fs.renameSync(`${STATE}.tmp`, STATE);
  } catch {
    /* state is best effort; the next save retries */
  }
}
function loadState() {
  let saved = null;
  try {
    saved = STATE && JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    /* no saved state yet: start empty */
  }
  if (!Array.isArray(saved)) return false;
  for (const rec of saved) {
    for (const t of rec.turns) if (t.status === 'inProgress') t.status = 'interrupted';
    rec.thread.status = { type: 'idle' };
    threads.set(rec.thread.id, rec);
  }
  return true;
}
if (!loadState()) seedThreads();

/** A command waiting on the user's approval card; true once it was allowed (and ran). */
async function approveCommand(rec, turn, threadId, turnId) {
  const item = {
    type: 'commandExecution',
    id: randomUUID(),
    command: 'npm test',
    cwd: rec.thread.cwd,
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  turn.items.push(item);
  notify('item/started', { item: { ...item }, threadId, turnId, startedAtMs: Date.now() });
  const res = await ask(
    'item/commandExecution/requestApproval',
    { threadId, turnId, itemId: item.id, command: 'npm test', cwd: rec.thread.cwd, reason: null },
    60_000,
  );
  const ok = !!res?.result?.decision && res.result.decision !== 'decline' && res.result.decision !== 'cancel';
  Object.assign(item, ok ? { status: 'completed', aggregatedOutput: 'tests passed', exitCode: 0, durationMs: 1 } : { status: 'declined' });
  notify('item/completed', { item: { ...item }, threadId, turnId, completedAtMs: Date.now() });
  return ok;
}

async function runTurn(rec, turn, original) {
  const text = turn.items.some((item) => item.type === 'userMessage') ? fakeControlText(original) : original;
  // EDITFILE: an "Implement the plan." turn carries out the edit its plan prompt asked for
  const wants = (w) => text.includes(w) || (text === 'Implement the plan.' && (rec.planPrompt ?? '').includes(w));
  const threadId = rec.thread.id;
  const turnId = turn.id;
  const at = () => Date.now();
  rec.thread.status = { type: 'active', activeFlags: [] };
  notify('thread/status/changed', { threadId, status: rec.thread.status });
  notify('turn/started', { threadId, turn: { ...turn, items: [] } });
  // goal turns have no user message
  const user = turn.items[0];
  if (user) {
    notify('item/started', { item: user, threadId, turnId, startedAtMs: at() });
    notify('item/completed', { item: user, threadId, turnId, completedAtMs: at() });
  }
  if (!rec.title && TROUBLE.test(text)) return trouble(rec, turn, text);

  const refused = !rec.title && /USAGELIMIT|AUTHEXPIRED/.test(text) ? await accounts.turnRefusal(text) : null;
  if (refused) {
    notify('error', { error: refused, willRetry: false, threadId, turnId });
    Object.assign(turn, { status: 'failed', error: refused, completedAt: now(), durationMs: 1 });
    rec.thread.status = { type: 'idle' };
    rec.running = null;
    saveState();
    notify('turn/completed', { threadId, turn: { ...turn, items: [...turn.items] } });
    notify('thread/status/changed', { threadId, status: rec.thread.status });
    return;
  }

  // THINK / THINKTWICE: reasoning ahead of the reply (fake-turn-details.mjs)
  if (!rec.title) await streamCodexThoughts(text, { notify, sleep, turn, threadId, turnId, cwd: rec.thread.cwd });

  if (!rec.title && text.includes('CRASH')) return crashTurn(rec, turn, at);

  if (!rec.title && rec.mode === 'plan') {
    // plan mode: a plan item only when asked for (sol-style), else the plan is just the message
    rec.planPrompt = text;
    if (text.includes('APPROVECMD')) await approveCommand(rec, turn, threadId, turnId);
    const plan = `1. Read the code\n2. Change it for: ${text}`;
    const user = turn.items[0];
    const out = text.includes('PLANITEM')
      ? [
          { type: 'plan', id: randomUUID(), text: plan },
          {
            type: 'agentMessage',
            id: randomUUID(),
            text: 'Plan ready.',
            phase: null,
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
        ]
      : [
          {
            type: 'agentMessage',
            id: randomUUID(),
            text: `Plan:\n${plan}`,
            phase: null,
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
        ];
    turn.items = user ? [user] : [];
    for (const item of out) {
      await sleep(STEP_MS);
      turn.items.push(item);
      notify('item/started', { item, threadId, turnId, startedAtMs: at() });
      notify('item/completed', { item, threadId, turnId, completedAtMs: at() });
    }
    turn.status = 'completed';
    turn.completedAt = now();
    turn.durationMs = 1;
    rec.thread.status = { type: 'idle' };
    rec.running = null;
    saveState();
    notify('turn/completed', { threadId, turn: { ...turn, items: [...turn.items] } });
    notify('thread/status/changed', { threadId, status: rec.thread.status });
    return;
  }

  if (!rec.title && text.includes('BGTERM')) {
    const cmd = {
      type: 'commandExecution',
      id: randomUUID(),
      command: 'sleep 300',
      cwd: rec.thread.cwd,
      processId: '4242',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: '',
      exitCode: 0,
      durationMs: 1,
    };
    turn.items.push(cmd);
    notify('item/started', { item: { ...cmd, status: 'inProgress' }, threadId, turnId, startedAtMs: at() });
    notify('item/completed', { item: cmd, threadId, turnId, completedAtMs: at() });
    rec.terminals = [
      ...(rec.terminals ?? []),
      { itemId: cmd.id, processId: '4242', command: 'sleep 300', cwd: rec.thread.cwd, osPid: null, cpuPercent: null, rssKb: null },
    ];
    // "BGTERM <n>s": the command ends on its own after n seconds
    const ends = /BGTERM (\d+)s/.exec(text);
    if (ends)
      setTimeout(() => {
        rec.terminals = (rec.terminals ?? []).filter((t) => t.processId !== '4242');
      }, Number(ends[1]) * 1000);
  }
  if (!rec.title && text.includes('SPAWN')) {
    // the sub-agent's own thread, already done with its task
    const sub = newThread({ cwd: rec.thread.cwd });
    Object.assign(sub.thread, { parentThreadId: threadId, agentNickname: 'Tester', preview: 'look at the tests' });
    const t = now();
    sub.turns.push({
      id: randomUUID(),
      itemsView: 'full',
      status: 'completed',
      error: null,
      startedAt: t,
      completedAt: t,
      durationMs: 1,
      items: [
        {
          type: 'userMessage',
          id: randomUUID(),
          clientId: null,
          content: [{ type: 'text', text: 'look at the tests', text_elements: [] }],
        },
        {
          type: 'agentMessage',
          id: randomUUID(),
          text: 'fake-codex sub-agent: the tests pass',
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      ],
    });
    const spawn = {
      type: 'collabAgentToolCall',
      id: randomUUID(),
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: threadId,
      receiverThreadIds: [sub.thread.id],
      prompt: 'look at the tests',
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    };
    turn.items.push(spawn);
    notify('item/started', { item: { ...spawn, status: 'inProgress' }, threadId, turnId, startedAtMs: at() });
    notify('item/completed', { item: spawn, threadId, turnId, completedAtMs: at() });
    if (text.includes('SPAWN_REPLY_PARENT')) {
      notify('thread/started', { thread: sub.thread });
      notify('item/completed', {
        threadId: sub.thread.id,
        turnId: sub.turns[0].id,
        item: {
          type: 'collabAgentToolCall',
          id: randomUUID(),
          tool: 'sendMessage',
          status: 'completed',
          senderThreadId: sub.thread.id,
          receiverThreadIds: [threadId],
          agentsStates: {},
        },
      });
    }
  }

  let toolText = '';
  const call = !rec.title && /TOOLCALL (\S+)/.exec(text);
  if (call) {
    ask('attestation/generate', {});
    const res = await ask('item/tool/call', {
      threadId,
      turnId,
      callId: randomUUID(),
      namespace: null,
      tool: 'sage_debug_echo',
      arguments: { text: call[1] },
    });
    toolText = ` [${res?.result?.contentItems?.map((c) => c.text).join(' ') ?? res?.error?.message ?? 'no answer'}]`;
  }
  const goalRound = goalRoundOf(turn);
  toolText += await callDynamicTools({ ask, notify, rec, turn, threadId, turnId, text });
  // APPROVECMD: a command that waits on the user's approval (card answered in the app); EDITFILE: an
  // edit of hello.txt in the chat's folder, written only once approved. Each outcome goes in the reply.
  if (!rec.title && text.includes('APPROVECMD'))
    toolText += ` [command: ${(await approveCommand(rec, turn, threadId, turnId)) ? 'ran' : 'declined'}]`;
  if (!rec.title && wants('EDITFILE')) {
    const file = path.join(rec.thread.cwd, 'hello.txt');
    const item = {
      type: 'fileChange',
      id: randomUUID(),
      status: 'inProgress',
      changes: [{ path: file, kind: { type: 'add' }, diff: 'hello\nworld\n' }],
    };
    turn.items.push(item);
    notify('item/started', { item: { ...item }, threadId, turnId, startedAtMs: at() });
    const res = await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: item.id, reason: null, grantRoot: null }, 60_000);
    const ok = !!res?.result?.decision && res.result.decision !== 'decline' && res.result.decision !== 'cancel';
    if (ok) fs.writeFileSync(file, 'hello\nworld\n');
    item.status = ok ? 'completed' : 'declined';
    notify('item/completed', { item: { ...item }, threadId, turnId, completedAtMs: at() });
    toolText += ` [edit: ${ok ? 'written' : 'declined'}]`;
  }
  if (!rec.title && /RELAY(CHILD)?PROBE/.test(text)) toolText += await probeRelay(rec.relay, text.includes('RELAYCHILDPROBE'));
  const mcpCall = !rec.title && /MCPCALL (\S+)/.exec(text);
  if (mcpCall) toolText += (await callMcp(rec, threadId, mcpCall[1])).map((t) => ` [mcp ${t}]`).join('');
  const hostCalls = rec.title
    ? { text: '', interrupted: false }
    : await callHostTools(rec, turn, threadId, turnId, text, { scriptedGoal: goalRound });
  toolText += hostCalls.text;
  const reply = rec.title ? 'Fake chat title' : (fakeMomoReply(original) ?? `fake-codex: ${original}${toolText}`);
  const agent = { type: 'agentMessage', id: randomUUID(), text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
  turn.items.push(agent);
  notify('item/started', { item: { ...agent }, threadId, turnId, startedAtMs: at() });
  const slow = !rec.title && (text.includes('SLOW') || heldNext(LOG));
  // A controlled pause lets the renderer regression test inspect existing nodes
  // after their entrance animation finishes, before the next delta arrives.
  const markdownStream = !rec.title && text.includes('STREAMMARKDOWN');
  const chunks = markdownStream
    ? [
        '| Name | Value |\n| --- | --- |\n| First | One |\n\n[the docs](https://example.com)\n\n```js\nconst first = 1;\n```\n\nExisting words stay visible ',
        'when more words arrive. '.repeat(80),
      ]
    : slow
      ? [text.includes('HOLDREPLY') ? '' : reply]
      : reply.match(/.{1,8}/gs) || [''];
  for (const [index, delta] of chunks.entries()) {
    if (markdownStream && index === 1) {
      const signal = `${process.env.FAKE_CODEX_LOG}.markdown-next`;
      while (!fs.existsSync(signal)) await sleep(50);
      fs.rmSync(signal, { force: true });
    }
    if ((await sleep(STEP_MS), hostCalls.interrupted)) break; // a Stop while the reply is written (fake-codex-mcp.mjs)
    agent.text += delta;
    notify('item/agentMessage/delta', { threadId, turnId, itemId: agent.id, delta });
  }
  if (hostCalls.interrupted) turn.status = 'interrupted';
  else if (slow) {
    // ends interrupted on turn/interrupt, or completed once the test writes $FAKE_CODEX_LOG.release
    const release = process.env.FAKE_CODEX_LOG ? `${process.env.FAKE_CODEX_LOG}.release` : null;
    turn.status = await new Promise((resolve) => {
      const poll = release
        ? setInterval(() => {
            if (!fs.existsSync(release)) return;
            fs.rmSync(release, { force: true });
            clearInterval(poll);
            waiting.delete(turnId);
            resolve('completed');
          }, 50)
        : null;
      waiting.set(turnId, () => (clearInterval(poll), resolve('interrupted')));
      steerable.set(turnId, () => (clearInterval(poll), waiting.delete(turnId), resolve('completed')));
    });
    steerable.delete(turnId);
  } else turn.status = 'completed';
  notify('item/completed', { item: { ...agent }, threadId, turnId, completedAtMs: at() });
  // a message steered into this turn (turn/steer): it joins the turn and gets its own reply
  if (rec.steered) {
    const { text: t, clientId } = rec.steered;
    rec.steered = null;
    const u = { type: 'userMessage', id: randomUUID(), clientId, content: [{ type: 'text', text: t, text_elements: [] }] };
    const a2 = {
      type: 'agentMessage',
      id: randomUUID(),
      text: `fake-codex: ${t}${(await callHostTools(rec, turn, threadId, turnId, t)).text}`,
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    for (const item of [u, a2]) {
      turn.items.push(item);
      notify('item/started', { item, threadId, turnId, startedAtMs: at() });
      notify('item/completed', { item, threadId, turnId, completedAtMs: at() });
    }
  }
  turn.completedAt = now();
  turn.durationMs = Math.max(1, at() - turn.startedAt * 1000);
  rec.thread.updatedAt = now();
  rec.thread.status = { type: 'idle' };
  rec.running = null;
  saveState();
  if (!rec.title) codexTurnEnd(text, { notify, threadId, turnId });
  notify('turn/completed', { threadId, turn: { ...turn, items: [...turn.items] } });
  notify('thread/status/changed', { threadId, status: rec.thread.status });
  // a goal whose objective says FINISH is met by its third round (the first, the unattended second, and the resumed one)
  if (
    goalRound &&
    turn.status === 'completed' &&
    rec.goal?.status === 'active' &&
    /FINISH/.test(rec.goal.objective) &&
    rec.goalRounds >= 3
  ) {
    rec.goal = { ...rec.goal, status: 'complete', updatedAt: now() };
    notify('thread/goal/updated', { threadId, turnId, goal: rec.goal });
  }
  // an active goal goes on by itself: the next round starts with nobody asking for it
  if (
    goalRound &&
    turn.status === 'completed' &&
    rec.goal?.status === 'active' &&
    /CONTINUE/.test(rec.goal.objective) &&
    rec.goalRounds < 2
  )
    setTimeout(() => !rec.running && rec.goal?.status === 'active' && startTurn(rec, null, null, rec.goal.objective), 50);
}

// remote control: enable, then pairing/start gives a code; the first pairing/status claims it
const rcState = { on: false, clients: [] };
const rcView = () => ({
  status: rcState.on ? 'connected' : 'disabled',
  serverName: 'Fake Mac',
  installationId: 'inst-1',
  environmentId: rcState.on ? 'env-1' : null,
});
const external = { imported: false };
// what Settings wrote to config.toml (config/value/write), read back by config/read
const userConfig = { mcp_servers: {} };
const catalog = {
  plugins: [
    {
      id: 'notes-helper@openai-curated',
      name: 'notes-helper',
      installed: false,
      enabled: false,
      availability: 'AVAILABLE',
      installPolicy: 'AVAILABLE',
      interface: { displayName: 'Notes Helper', shortDescription: 'Keeps your notes tidy', category: 'Productivity' },
    },
  ],
  skills: [
    {
      name: 'tidy-notes',
      description: 'Tidy my notes folder',
      path: path.join(process.env.HOME ?? '/', '.codex', 'skills', 'tidy-notes', 'SKILL.md'),
      scope: 'user',
      enabled: true,
      interface: null,
    },
  ],
};
const accounts = createFakeCodexAccounts(CODEX_HOME, notify, ask);
const signOut = () => accounts.handlers['account/logout']();
const trouble = createFakeCodexTrouble({ notify, log, saveState, waiting, signOut, now, sleep });
const crashTurn = createCrashTurn({ notify, ask, log, saveState });
const handlers = {
  'remoteControl/status/read': () => rcView(),
  'remoteControl/enable': () => ((rcState.on = true), rcView()),
  'remoteControl/disable': () => ((rcState.on = false), rcView()),
  'remoteControl/pairing/start': () => ({
    pairingCode: 'PAIR-1',
    manualPairingCode: 'AB12-CD34',
    environmentId: 'env-1',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  }),
  'remoteControl/pairing/status': () => (
    rcState.clients.length ||
      rcState.clients.push({
        clientId: 'phone-1',
        displayName: 'Test Phone',
        deviceType: 'phone',
        platform: 'iOS',
        osVersion: '19',
        deviceModel: null,
        appVersion: null,
        lastSeenAt: 1,
      }),
    { claimed: true }
  ),
  'remoteControl/client/list': () => ({ data: rcState.clients, nextCursor: null }),
  'remoteControl/client/revoke': (p) => ((rcState.clients = rcState.clients.filter((c) => c.clientId !== p.clientId)), {}),
  initialize: () => ({ userAgent: `fake-codex/${VERSION}`, codexHome: CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' }),
  ...accounts.handlers,
  ...configHandlers,
  // setup another app left behind: Claude Code's CLAUDE.md is offered until it was imported
  'externalAgentConfig/detect': () => ({
    items: external.imported
      ? []
      : [{ itemType: 'AGENTS_MD', description: 'Import CLAUDE.md from Claude Code as AGENTS.md', cwd: null, details: null }],
    connectors: [],
  }),
  'externalAgentConfig/import': () => ((external.imported = true), {}),
  // one plugin in a curated marketplace (install and uninstall flip it) and one personal skill (skills/config/write toggles it)
  'plugin/list': () => ({
    marketplaces: [{ name: 'openai-curated', path: '/fake/marketplace', plugins: catalog.plugins }],
    featuredPluginIds: catalog.plugins.map((x) => x.id),
    marketplaceLoadErrors: [],
  }),
  'plugin/install': (p) => {
    const plugin = catalog.plugins.find((x) => x.name === p.pluginName);
    if (plugin) Object.assign(plugin, { installed: true, enabled: true, installedAt: Date.now() });
    return { authPolicy: 'ON_USE', appsNeedingAuth: [] };
  },
  'plugin/uninstall': (p) => {
    const plugin = catalog.plugins.find((x) => x.id === p.pluginId);
    if (plugin) Object.assign(plugin, { installed: false, enabled: false });
    return {};
  },
  'skills/list': (p) => ({
    data: (p.cwds?.length ? p.cwds : [process.env.HOME ?? '/']).slice(0, 1).map((cwd) => ({ cwd, skills: catalog.skills, errors: [] })),
  }),
  'skills/config/write': (p) => {
    const skill = catalog.skills.find((x) => x.path === p.path);
    if (skill) skill.enabled = !!p.enabled;
    return { effectiveEnabled: !!p.enabled };
  },
  'account/rateLimits/read': () => ({
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      normalModelSlug: null,
      // FAKE_CODEX_USAGE=1: 42% of the 5-hour window and 10% of the weekly one used
      primary: process.env.FAKE_CODEX_USAGE ? { usedPercent: 42, windowDurationMins: 300, resetsAt: now() + 3600 } : null,
      secondary: process.env.FAKE_CODEX_USAGE ? { usedPercent: 10, windowDurationMins: 10080, resetsAt: now() + 86400 } : null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  }),
  'model/list': () => ({ data: MODELS.map((m, i) => model(m, i === 0)), nextCursor: null }),
  'config/read': () => ({ config: configOf(CODEX_HOME, MODELS[0], userConfig.mcp_servers), origins: {}, layers: null }),
  // config.toml writes the Settings pages make: mcp_servers."<name>" (a table, or null to remove it) and its keys
  'config/value/write': (p) => {
    const parts = [...String(p.keyPath).matchAll(/"((?:[^"\\]|\\.)*)"|([^.]+)/g)].map((m) =>
      m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2],
    );
    let at = userConfig;
    for (const k of parts.slice(0, -1)) at = at[k] ??= {};
    const last = parts.at(-1);
    if (p.value === null) delete at[last];
    else at[last] = p.value;
    return { status: 'ok', version: 'v1', filePath: path.join(CODEX_HOME, 'config.toml'), overriddenMetadata: null };
  },
  'config/mcpServer/reload': () => ({}),
  // each configured server is "connected", with no tools and no login to do
  'mcpServerStatus/list': () => ({
    data: Object.keys(userConfig.mcp_servers).map((name) => ({
      name,
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    })),
    nextCursor: null,
  }),
  'thread/list': (p) => {
    const term = (p.searchTerm || '').toLowerCase();
    const data = [...threads.values()]
      .filter((r) => !r.thread.ephemeral && !r.thread.parentThreadId && r.archived === !!p.archived && r.turns.length > 0)
      .filter((r) => !term || `${r.thread.name ?? ''}\n${r.thread.preview}`.toLowerCase().includes(term))
      .sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)
      .map((r) => view(r));
    // pages by offset: the cursor is the index of the first chat on the next page
    const start = Number(p.cursor) || 0;
    const end = p.limit ? start + p.limit : data.length;
    return { data: data.slice(start, end), nextCursor: end < data.length ? String(end) : null, backwardsCursor: null };
  },
  'plugin/installed': () => ({
    marketplaces: [
      {
        name: 'openai-bundled',
        path: '/fake/bundled',
        plugins: [{ id: 'unified-computer-use@openai-bundled', name: 'unified-computer-use', installed: true, enabled: true }],
      },
    ],
    marketplaceLoadErrors: [],
  }),
  'thread/start': (p) => {
    // a provider nothing defines is refused, as the real app-server does (X9); the version probe relies on it
    if (
      p.modelProvider &&
      !['openai', 'ollama', 'lmstudio'].includes(p.modelProvider) &&
      !p.config?.model_providers?.[p.modelProvider] &&
      p.config?.model_provider !== p.modelProvider
    )
      throw Object.assign(new Error(`failed to load configuration: Model provider \`${p.modelProvider}\` not found`), { code: -32600 });
    const rec = newThread(p);
    useMcpConfig(rec, p.config);
    rec.relay = relayOf(p.config);
    setImmediate(() => notify('thread/started', { thread: view(rec) }));
    return sessionInfo(rec);
  },
  'thread/resume': (p) => {
    const rec = getThread(p.threadId);
    useMcpConfig(rec, p.config);
    // a thread loaded with its goal active carries on with it by itself
    if (rec.goal?.status === 'active' && !rec.running)
      setImmediate(() => !rec.running && rec.goal?.status === 'active' && startTurn(rec, null, null, rec.goal.objective));
    return {
      ...sessionInfo(rec),
      thread: view(rec, !p.excludeTurns),
      collaborationMode: null,
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    };
  },
  'thread/read': (p) => ({ thread: view(otherAppTurn(getThread(p.threadId)), !!p.includeTurns) }),
  'thread/turns/list': createFakeCodexHistory({ getThread, otherAppTurn, elsewhereDone, notify, saveState, log: LOG, record: log, send }),
  'turn/start': (p) => {
    const rec = getThread(p.threadId);
    setMode(rec, p.collaborationMode);
    const turn = startTurn(rec, p.input || [], p.clientUserMessageId);
    return { turn: { ...turn, items: [] } };
  },
  // a message sent into the running turn: the turn takes it up and finishes (see the steered block in runTurn)
  'turn/steer': (p) => {
    const rec = getThread(p.threadId);
    // like the app-server: only into the turn that is running now
    if (!rec.running || rec.running !== p.expectedTurnId)
      throw Object.assign(new Error(`no active turn to steer: ${p.expectedTurnId}`), { code: -32600 });
    rec.steered = { text: (p.input || []).map((i) => i.text ?? '').join(''), clientId: p.clientUserMessageId ?? null };
    // The turn takes the message up and ends right behind this answer, in the same write: what main
    // reads from a busy app-server, where the answer and the turn's last notifications come in one chunk.
    oneWrite();
    steerable.get(p.expectedTurnId)?.();
    return { turnId: p.expectedTurnId };
  },
  'turn/interrupt': (p) => {
    const done = waiting.get(p.turnId);
    waiting.delete(p.turnId);
    done?.();
    return {};
  },
  // an edited message: the thread goes back to before that turn
  'thread/revert': (p) => {
    const rec = getThread(p.threadId);
    const i = rec.turns.findIndex((t) => t.id === p.beforeTurnId);
    if (i >= 0) rec.turns = rec.turns.slice(0, i);
    return { thread: { ...rec.thread, turns: [] } };
  },
  'thread/name/set': (p) => {
    const rec = getThread(p.threadId);
    rec.thread.name = p.name;
    setImmediate(() => notify('thread/name/updated', { threadId: p.threadId, threadName: p.name }));
    return {};
  },
  'thread/archive': (p) => {
    getThread(p.threadId).archived = true;
    setImmediate(() => notify('thread/archived', { threadId: p.threadId }));
    return {};
  },
  'thread/unarchive': (p) => {
    const rec = getThread(p.threadId);
    rec.archived = false;
    setImmediate(() => notify('thread/unarchived', { threadId: p.threadId }));
    return { thread: view(rec) };
  },
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  'thread/backgroundTerminals/list': (p) => ({ data: getThread(p.threadId).terminals ?? [], nextCursor: null }),
  'thread/backgroundTerminals/terminate': (p) => {
    const rec = getThread(p.threadId);
    const had = (rec.terminals ?? []).some((t) => t.processId === p.processId);
    rec.terminals = (rec.terminals ?? []).filter((t) => t.processId !== p.processId);
    return { terminated: had };
  },
  'thread/fork': (p) => {
    const src = getThread(p.threadId);
    const rec = newThread({ cwd: src.thread.cwd, ephemeral: p.ephemeral, model: src.thread.model });
    const upTo = p.lastTurnId ? src.turns.findIndex((t) => t.id === p.lastTurnId) : src.turns.length - 1;
    rec.turns = structuredClone(src.turns.slice(0, upTo + 1));
    rec.thread.forkedFromId = src.thread.id;
    rec.thread.preview = src.thread.preview;
    if (src.goal) rec.goal = { ...src.goal, threadId: rec.thread.id };
    setImmediate(() => notify('thread/started', { thread: view(rec) }));
    return sessionInfo(rec);
  },
  // an inline review: entered, the request, a look at the diff, the result, then the result again as a message (X4)
  'review/start': (p) => {
    const rec = getThread(p.threadId);
    const label = p.target?.type === 'uncommittedChanges' ? 'current changes' : 'the changes';
    const review = codexReviewText(rec.thread.cwd);
    const msg = (text) => ({
      type: 'agentMessage',
      id: randomUUID(),
      text,
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    });
    const turn = startTurn(rec, null, null, 'review', (r, t) =>
      scriptedTurn(r, t, [
        { type: 'enteredReviewMode', id: randomUUID(), review: label },
        { type: 'userMessage', id: randomUUID(), clientId: null, content: [{ type: 'text', text: `Review ${label}`, text_elements: [] }] },
        msg('Looking at the diff'),
        { type: 'exitedReviewMode', id: randomUUID(), review },
        msg(review),
      ]),
    );
    return { turn: { ...turn, items: [] }, reviewThreadId: p.threadId };
  },
  // a turn that holds only the compaction, with nothing saying who asked for it (X5)
  'thread/compact/start': (p) => {
    const rec = getThread(p.threadId);
    startTurn(rec, null, null, 'compact', (r, t) => scriptedTurn(r, t, [{ type: 'contextCompaction', id: randomUUID() }]));
    return {};
  },
  'thread/goal/get': (p) => ({ goal: threads.get(p.threadId)?.goal ?? null }),
  'thread/goal/set': (p) => {
    const rec = getThread(p.threadId);
    if (rec.thread.ephemeral) throw Object.assign(new Error(`ephemeral thread does not support goals: ${p.threadId}`), { code: -32600 });
    const t = now();
    const prev = p.objective != null && p.objective !== rec.goal?.objective ? null : rec.goal;
    const goal = {
      threadId: p.threadId,
      objective: p.objective ?? prev?.objective ?? '',
      status: p.status ?? prev?.status ?? 'active',
      tokenBudget: p.tokenBudget !== undefined ? p.tokenBudget : (prev?.tokenBudget ?? null),
      tokensUsed: prev?.tokensUsed ?? 0,
      timeUsedSeconds: prev?.timeUsedSeconds ?? 0,
      createdAt: prev?.createdAt ?? t,
      updatedAt: t,
    };
    rec.goal = goal;
    setImmediate(() => {
      notify('thread/goal/updated', { threadId: p.threadId, turnId: rec.running ?? null, goal });
      // an active goal on an idle thread starts working on it by itself
      if (goal.status === 'active' && !rec.running) startTurn(rec, null, null, goal.objective);
    });
    return { goal };
  },
  'thread/goal/clear': (p) => {
    const rec = getThread(p.threadId);
    const cleared = !!rec.goal;
    rec.goal = null;
    if (cleared) setImmediate(() => notify('thread/goal/cleared', { threadId: p.threadId }));
    return { cleared };
  },
  'project/list': () => {
    if (process.env.FAKE_CODEX_PROJECTS_FAIL) throw new Error('project/list is not available');
    return { data: projects.map((p, i) => ({ ...p, position: i })), nextCursor: null };
  },
  'project/create': (p) => {
    const project = fakeProject(p.name, p.roots?.[0]?.path, projects.length);
    projects.push(project);
    projectChanged(project.id, 'created');
    return { project };
  },
  'project/update': (p) => {
    const project = projects.find((x) => x.id === p.projectId);
    if (!project) throw new Error(`no project ${p.projectId}`);
    if (p.name) project.name = p.name;
    projectChanged(project.id, 'updated');
    return { project };
  },
  'project/delete': (p) => {
    const i = projects.findIndex((x) => x.id === p.projectId);
    if (i >= 0) projects.splice(i, 1);
    projectChanged(p.projectId, 'deleted');
    return {};
  },
  'fs/createDirectory': (p) => {
    if (p.path) fs.mkdirSync(p.path, { recursive: p.recursive !== false });
    return {};
  },
  // the scheduled tasks in $CODEX_HOME/automations (src/lib/automations.ts)
  'fs/readDirectory': (p) => {
    let names = [];
    try {
      names = fs.readdirSync(p.path, { withFileTypes: true });
    } catch {
      /* a missing directory lists as empty */
    }
    return { entries: names.map((e) => ({ fileName: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })) };
  },
  'fs/readFile': (p) => ({ dataBase64: fs.readFileSync(p.path).toString('base64') }),
  'fs/writeFile': (p) => (fs.writeFileSync(p.path, Buffer.from(p.dataBase64, 'base64')), {}),
};
const threadSettings = withThreadSettings(handlers, LOG);

function handle(msg) {
  if (msg.method == null) {
    // a response to one of the fake's server requests
    log({ id: msg.id ?? null, method: null, response: { result: msg.result, error: msg.error } });
    asked.get(msg.id)?.(msg);
    asked.delete(msg.id);
    return;
  }
  log({ id: msg.id ?? null, method: msg.method, params: msg.params ?? null });
  if (msg.id == null) return; // a notification, e.g. `initialized`
  const fn = handlers[msg.method];
  const refused = refusal(msg.method);
  if (refused) return send({ id: msg.id, error: refused });
  // anything not scripted gets an empty result (a list for */list), so the app never hangs
  const response = () => (fn ? fn(msg.params || {}) : /\/list$/.test(msg.method) ? { data: [], nextCursor: null } : {});
  replyNativeRequest(msg, response, fn?.reply || send, { logFile: LOG, saveState });
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
  handle(msg);
});
rl.on('close', () => process.exit(0));
