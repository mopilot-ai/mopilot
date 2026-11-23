#!/usr/bin/env node
// A minimal Agent Client Protocol (v1) agent for tests: JSON-RPC 2.0, one message per line on stdio.
// - initialize declares its capabilities (mcpCapabilities included); $FAKE_ACP_PROFILE (JSON) can
//   turn on loadSession, sessionCapabilities.resume and .close (session/close forgets one) and promptCapabilities.image, list authMethods,
//   answer with another protocolVersion, refuse session/new until signed in (needsAuth: until
//   $FAKE_ACP_STATE/authed exists, which authenticate or a terminal login creates), or ignore the
//   MCP servers it is given (noMcp), refuse stdio ones as Copilot CLI does (rejectStdio), connect the http ones it
//   is given (httpMcp); terminalLogin lists a terminal-auth method that runs this
//   script with --login; `modes` and `configOptions` come back from session/new and change with
//   session/set_mode and session/set_config_option; `commands` are pushed with
//   available_commands_update right after session/new; `usage` sends a usage_update per prompt;
//   `permissionOptions` replaces the allow/reject pair it asks with; `dumpConfig`, `noProvider` and `needsKey` act
//   as dsh does (fake-acp-dsh.mjs); `browserLogin` makes authenticate wait like a browser sign-in
//   (fake-acp-signin.mjs);
// - session/new records the mcpServers it was given, and for each stdio one actually spawns it and
//   runs the MCP initialize handshake (and tools/list), logging the outcome (an http one too, with httpMcp). session/load and
//   session/resume reopen a session kept in $FAKE_ACP_STATE (a folder), so they work across restarts;
//   load replays the history as updates first;
// - session/prompt streams agent_message_chunk "fake-acp: <text>" ("Fake chat title" for a title request) and ends with a stopReason. Words in
//   the prompt add steps first:
//   PERMIT       a tool call, then session/request_permission (allow / reject)
//   SAGEPERMIT   session/request_permission for mcp__<its first MCP server>__sage_debug_echo
//   FOREIGNPERMIT <server>  session/request_permission for mcp__<server>__sage_debug_echo, another chat's server
//   REFUSE       the prompt ends with stopReason "refusal" (the agent's safety filter paused the chat); RATELIMITED fails it with "Rate limit exceeded"
//   SPEND <model> <in> <out>  the turn ends with a usage report of that model and token counts (`usage` of the prompt result), so the Host can price it
//   SLOW         wait after the first chunk until session/cancel (HOLDREPLY too: no chunk at all, so its steps stay the thread's last rows)
//   PROVIDERFAIL its provider fails as opencode's does: a "stream error" line on stderr for its title agent and its
//                main agent (opencode with --print-logs), then nothing, retrying silently until session/cancel
//   MCPCALL <w>  call sage_debug_echo on each MCP server it connected, answers in the reply
//   MCPTOOL <name> <json>  call tool <name> with the JSON arguments (no spaces) on the server that lists it, as a tool call
//                titled the way opencode titles one (<server>_<tool>), its text in the reply
//   THINK        an agent_thought_chunk
//   TOOL         an execute tool call that completes with output
//   SUBAGENT [ms]  a sub-agent call (an Agent tool with a description, a prompt and a type) that runs one child
//                execute call (named by _meta.claudeCode.parentToolUseId) for [ms] (default 10), then completes with a report
//   EDIT <path>  an edit tool call with a diff for <path>
//   FSREAD <p>   fs/read_text_file <p>, its content in the reply
//   FSWRITE <p> <w>  fs/write_text_file <w> to <p>
//   TERM <w>     terminal/create echo <w>, wait for it, its output in the reply
//   HISTORY      how many prompts the session had before this one
//   SETTINGS     the current mode and config values
//   EXT <method> a harness extension request to the client, its answer in the reply
//   /<name>      a listed command runs: the reply is "ran /<name>"
//   LATE         after the prompt ends: a tool call and a permission request with no prompt running
// - session/cancel ends the running prompt with stopReason "cancelled" (profile ignoreCancel: true never does; a
//   number ignores that many cancels of a prompt first).
// Every message in and out, and each MCP connection, is appended to $FAKE_ACP_LOG (JSONL); the first
// line is the argv and the env keys it started with (kind 'argv').
import fs from 'node:fs';
import { RpcError, errorReply } from './acpError.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { authMethods, authenticate, authed as isAuthed, terminalLogin } from './fake-acp-signin.mjs';
import { children, connectHttpMcp, connectMcp, lines, mcpWords } from './fake-acp-mcp.mjs';
import { dumpConfig, providerOptions, turnError } from './fake-acp-dsh.mjs';
import { withoutMomoContext } from '../e2e/fixtures/fake-control-text.mjs';
import { heldNext, released } from '../e2e/fixtures/fake-turn-details.mjs';
import { savedSession } from './fake-acp-state.mjs';

const VERSION = '0.0.0-fake';
// FAKE_STAY: a child that does not leave when its parent goes (stdin closing), as a stuck agent does not
if (process.env.FAKE_STAY) setInterval(() => undefined, 1_000_000);
const LOG = process.env.FAKE_ACP_LOG;
const STATE = process.env.FAKE_ACP_STATE || null;
const { save, saved } = savedSession(STATE);
const PROFILE = (() => {
  try {
    return JSON.parse(process.env.FAKE_ACP_PROFILE || '{}');
  } catch {
    return {};
  }
})();
const STEP_MS = 10;

await terminalLogin(process.argv);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + '\n');
  } catch {
    /* debug log only: a failed write must not break the fake agent */
  }
}
log({
  kind: 'argv',
  argv: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(DSH_|FAKE_ACP_PROFILE$)/.test(k))),
});

// `--dump-config` (dsh): the composed profile tree the way dsh prints it (fake-acp-dsh.mjs)
if (process.argv.includes('--dump-config')) {
  process.stdout.write(dumpConfig(process.argv, PROFILE));
  process.exit(0);
}

function send(msg) {
  const m = { jsonrpc: '2.0', ...msg };
  log({ kind: 'out', msg: m });
  process.stdout.write(JSON.stringify(m) + '\n');
}
const notify = (method, params) => send({ method, params });

/* ---------- requests to the client ---------- */
const asked = new Map();
let nextAsk = 1;
function ask(method, params) {
  const id = `fake-acp-${nextAsk++}`;
  return new Promise((resolve, reject) => {
    asked.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

/* ---------- sessions ---------- */
/** id -> { cwd, mcpServers, mcp, history: [{prompt, reply}], running: { cancelled, wake } | null } */
const sessions = new Map();
function session(id) {
  const s = sessions.get(id);
  if (!s) throw new RpcError(-32602, `Unknown session: ${id}`);
  return s;
}

/** Open (or reopen) a session and connect its MCP servers. */
async function openSession(sessionId, p, history = []) {
  if (typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd)) throw new RpcError(-32602, 'cwd must be an absolute path');
  const mcpServers = Array.isArray(p.mcpServers) && !PROFILE.noMcp ? p.mcpServers : [];
  const mcp = new Map();
  const s = {
    cwd: p.cwd,
    mcpServers,
    mcp,
    history,
    running: null,
    mode: PROFILE.modes?.currentModeId ?? null,
    config: Object.fromEntries((PROFILE.configOptions ?? []).map((o) => [o.id, o.currentValue])),
  };
  sessions.set(sessionId, s);
  log({ kind: 'session', sessionId, cwd: p.cwd, mcpServers });
  for (const server of mcpServers) {
    // stdio servers carry a command and no type; http ones are connected with httpMcp, sse ones only recorded
    const stdio = !server.type || server.type === 'stdio';
    if (stdio && PROFILE.rejectStdio) {
      log({ kind: 'mcp', sessionId, name: server.name, ok: false, error: 'Rejecting non-http/sse MCP server' });
      continue;
    }
    if (!stdio && !(PROFILE.httpMcp && server.type === 'http')) continue;
    const r = stdio ? await connectMcp(server, p.cwd) : await connectHttpMcp(server);
    log({ kind: 'mcp', sessionId, name: server.name, ...r });
    if (r.ok) mcp.set(server.name, r);
  }
  save(sessionId, s);
  return s;
}

// a block for the model only (annotations.audience without "user", as MoPilot's tools note) is not echoed,
// as a client shows only what the user wrote
const textOf = (prompt) =>
  (prompt || [])
    .filter((b) => b.type === 'text' && !(Array.isArray(b.annotations?.audience) && !b.annotations.audience.includes('user')))
    .map((b) => b.text)
    .join('\n');

const OPTIONS = PROFILE.permissionOptions ?? [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
const ALLOW = OPTIONS.find((o) => o.kind === 'allow_once')?.optionId;

async function prompt({ sessionId, prompt: blocks }) {
  const s = session(sessionId);
  if (s.running) throw new RpcError(-32600, 'A prompt is already running');
  const failed = turnError(PROFILE, STATE, sessionId);
  if (failed) throw new RpcError(-32603, failed);
  const run = { cancelled: false, wake: null };
  s.running = run;
  const update = (u) => notify('session/update', { sessionId, update: u });
  const text = textOf(blocks);
  let reply = /^Summarize the request below as a short chat title\b/.test(text)
    ? 'Fake chat title'
    : `fake-acp: ${withoutMomoContext(text)}`;
  try {
    if (text.includes('REFUSE')) return { stopReason: 'refusal' };
    if (text.includes('RATELIMITED')) throw new Error('Rate limit exceeded');
    if (text.includes('PROVIDERFAIL')) {
      for (const [small, agent] of [
        ['true', 'title'],
        ['false', 'build'],
      ])
        process.stderr.write(
          `timestamp=${new Date().toISOString()} level=ERROR run=fake message="stream error" providerID=fake modelID=m1 session.id=${sessionId} small=${small} agent=${agent} mode=primary error.error="AI_APICallError: Rate limit exceeded"\n`,
        );
      if (!run.cancelled) await new Promise((r) => (run.wake = r));
      return { stopReason: 'cancelled' };
    }
    if (text.includes('HISTORY')) reply += ` [history: ${s.history.length}]`;
    if (text.includes('SETTINGS')) reply += ` [mode: ${s.mode} config: ${JSON.stringify(s.config)}]`;
    const cmd = /^\/(\S+)/.exec(text.trim());
    if (cmd && (PROFILE.commands ?? []).some((c) => c.name === cmd[1])) reply = `ran /${cmd[1]}`;
    if (PROFILE.usage) update({ sessionUpdate: 'usage_update', used: 1000 * (s.history.length + 1), size: 200000 });
    if (text.includes('THINK')) update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking it over' } });
    if (/\bPERMIT\b/.test(text)) {
      const toolCallId = `call-${randomUUID()}`;
      const toolCall = { toolCallId, title: 'Fake action', kind: 'edit', status: 'pending' };
      update({ sessionUpdate: 'tool_call', ...toolCall });
      const res = await ask('session/request_permission', { sessionId, toolCall, options: OPTIONS }).catch(() => null);
      const outcome = res?.outcome;
      if (run.cancelled || outcome?.outcome === 'cancelled') return { stopReason: 'cancelled' };
      const allowed = outcome?.outcome === 'selected' && outcome.optionId === ALLOW;
      update({ sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed' });
    }
    if (text.includes('SAGEPERMIT')) {
      const name = [...s.mcp.keys()][0] ?? 'none';
      const toolCall = { toolCallId: `call-${randomUUID()}`, title: `mcp__${name}__sage_debug_echo`, kind: 'other', status: 'pending' };
      const res = await ask('session/request_permission', { sessionId, toolCall, options: OPTIONS }).catch(() => null);
      const o = res?.outcome;
      log({ kind: 'sagePermit', outcome: o });
      reply += ` [sage-permit: ${o?.outcome === 'selected' ? o.optionId : (o?.outcome ?? 'none')}]`;
    }
    const foreign = /FOREIGNPERMIT (sage_[0-9a-f]{12})/.exec(text);
    if (foreign) {
      const toolCall = {
        toolCallId: `call-${randomUUID()}`,
        title: `mcp__${foreign[1]}__sage_debug_echo`,
        kind: 'other',
        status: 'pending',
      };
      const res = await ask('session/request_permission', { sessionId, toolCall, options: OPTIONS }).catch(() => null);
      const o = res?.outcome;
      reply += ` [foreign-permit: ${o?.outcome === 'selected' ? o.optionId : (o?.outcome ?? 'none')}]`;
    }
    // a harness extension (Cursor's), asked of the client
    const ext = /EXT (\S+)/.exec(text);
    if (ext) {
      const r = await ask(ext[1], { sessionId, todos: [{ content: 'first step', status: 'in_progress' }], plan: '1. do it' }).catch(
        (e) => ({ error: e.message }),
      );
      reply += ` [ext: ${JSON.stringify(r)}]`;
    }
    // (a word of its own: MCPTOOL is not it)
    if (/\bTOOL\b/.test(text)) {
      const toolCallId = `call-${randomUUID()}`;
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'echo tool-ran',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'echo tool-ran' },
      });
      await sleep(STEP_MS);
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'tool-ran' } }],
      });
    }
    const sub = /\bSUBAGENT(?: (\d+))?/.exec(text);
    if (sub) {
      const agentId = `call-${randomUUID()}`;
      const childId = `call-${randomUUID()}`;
      const ms = Number(sub[1] ?? STEP_MS);
      update({
        sessionUpdate: 'tool_call',
        toolCallId: agentId,
        title: 'Track Z: check things',
        kind: 'other',
        status: 'in_progress',
        _meta: { claudeCode: { toolName: 'Agent' } },
        rawInput: { description: 'Track Z: check things', prompt: 'Check the things and report.', subagent_type: 'general-purpose' },
      });
      update({
        sessionUpdate: 'tool_call',
        toolCallId: childId,
        title: 'echo child',
        kind: 'execute',
        status: 'in_progress',
        _meta: { claudeCode: { parentToolUseId: agentId } },
        rawInput: { command: 'echo child' },
      });
      await sleep(ms);
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: childId,
        status: 'completed',
        _meta: { claudeCode: { parentToolUseId: agentId } },
        content: [{ type: 'content', content: { type: 'text', text: 'child' } }],
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: agentId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Z found nothing wrong.' } }],
      });
    }
    const edit = /EDIT (\S+)/.exec(text);
    if (edit) {
      const toolCallId = `call-${randomUUID()}`;
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `Edit ${edit[1]}`,
        kind: 'edit',
        status: 'in_progress',
        locations: [{ path: edit[1] }],
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'diff', path: edit[1], oldText: 'old line', newText: 'new line' }],
      });
    }
    const fsRead = /FSREAD (\S+)/.exec(text);
    if (fsRead) {
      const r = await ask('fs/read_text_file', { sessionId, path: fsRead[1] }).catch((e) => ({ content: `error ${e.message}` }));
      reply += ` [read: ${String(r?.content ?? '').trim()}]`;
    }
    const fsWrite = /FSWRITE (\S+) (\S+)/.exec(text);
    if (fsWrite) {
      await ask('fs/write_text_file', { sessionId, path: fsWrite[1], content: fsWrite[2] }).catch((e) =>
        log({ kind: 'fsWriteError', error: e.message }),
      );
      reply += ' [wrote]';
    }
    const term = /TERM (\S+)/.exec(text);
    if (term) {
      try {
        const { terminalId } = await ask('terminal/create', { sessionId, command: '/bin/echo', args: [term[1]] });
        const exit = await ask('terminal/wait_for_exit', { sessionId, terminalId });
        const out = await ask('terminal/output', { sessionId, terminalId });
        await ask('terminal/release', { sessionId, terminalId });
        reply += ` [term: ${String(out.output).trim()} exit ${exit.exitCode}]`;
      } catch (e) {
        reply += ` [term error: ${e.message}]`;
      }
    }
    reply += await mcpWords(text, s.mcp, { update, log, sessionId, profile: PROFILE });
    // HOLDREPLY (with SLOW): the held turn says nothing yet, so the thread still ends in the steps it ran
    const chunks =
      text.includes('SLOW') && text.includes('HOLDREPLY') ? [] : text.includes('SLOW') ? [reply] : reply.match(/.{1,8}/gs) || [''];
    for (const chunk of chunks) {
      if (run.cancelled) return { stopReason: 'cancelled' };
      await sleep(STEP_MS);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
    }
    if (text.includes('SLOW') && !run.cancelled) await new Promise((r) => (run.wake = r));
    if (reply !== 'Fake chat title' && heldNext(LOG)) await released(LOG);
    const spend = /\bSPEND (\S+) (\d+) (\d+)/.exec(text);
    return {
      stopReason: run.cancelled ? 'cancelled' : 'end_turn',
      ...(spend ? { usage: { model: spend[1], inputTokens: Number(spend[2]), outputTokens: Number(spend[3]) } } : {}),
    };
  } finally {
    s.running = null;
    if (!run.cancelled) {
      s.history.push({ prompt: text, reply });
      save(sessionId, s);
    }
    if (text.includes('LATE')) setTimeout(() => late(sessionId), 150);
  }
}

/** Work with no prompt running: a tool call, then a permission request. */
async function late(sessionId) {
  const toolCallId = `call-${randomUUID()}`;
  const toolCall = { toolCallId, title: 'Late action', kind: 'execute', status: 'pending', rawInput: { command: 'touch late' } };
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', ...toolCall } });
  const res = await ask('session/request_permission', { sessionId, toolCall, options: OPTIONS }).catch(() => null);
  log({ kind: 'latePermit', outcome: res?.outcome ?? null });
}

/** What session/load and session/resume answer: the session's modes and config, as session/new does. */
const reopened = (s) => ({
  ...(PROFILE.modes ? { modes: { ...PROFILE.modes, currentModeId: s.mode } } : {}),
  ...(PROFILE.configOptions ? { configOptions: configOptions(s) } : {}),
});
const configOptions = (s) => (PROFILE.configOptions ?? []).map((o) => ({ ...o, currentValue: s.config[o.id] }));
const authed = () => isAuthed(PROFILE, STATE);

const handlers = {
  initialize: (p) => ({
    protocolVersion: PROFILE.protocolVersion ?? Math.min(1, Number(p.protocolVersion) || 1),
    agentCapabilities: {
      loadSession: !!PROFILE.loadSession,
      promptCapabilities: { image: !!PROFILE.image, audio: false, embeddedContext: false },
      mcpCapabilities: { http: true, sse: false },
      ...(PROFILE.resume || PROFILE.close
        ? { sessionCapabilities: { resume: PROFILE.resume ? {} : undefined, close: PROFILE.close ? {} : undefined } }
        : {}),
    },
    agentInfo: { name: 'fake-acp', title: 'Fake ACP Agent', version: PROFILE.version ?? VERSION },
    authMethods: authMethods(PROFILE, STATE),
  }),
  authenticate: () => authenticate(PROFILE, STATE),
  'session/new': async (p) => {
    if (!authed()) throw new RpcError(-32000, 'Authentication required');
    const sessionId = `fake-acp-session-${randomUUID()}`;
    await openSession(sessionId, p);
    if (PROFILE.commands)
      setTimeout(
        () =>
          notify('session/update', {
            sessionId,
            update: { sessionUpdate: 'available_commands_update', availableCommands: PROFILE.commands },
          }),
        20,
      );
    return {
      sessionId,
      ...(PROFILE.modes ? { modes: PROFILE.modes } : {}),
      ...(PROFILE.configOptions ? { configOptions: configOptions(sessions.get(sessionId)) } : {}),
      ...providerOptions(PROFILE, STATE),
    };
  },
  'session/set_mode': ({ sessionId, modeId }) => {
    const s = session(sessionId);
    if (!PROFILE.modes?.availableModes?.some((m) => m.id === modeId)) throw new RpcError(-32602, `Unknown mode: ${modeId}`);
    s.mode = modeId;
    notify('session/update', { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } });
    return {};
  },
  'session/set_config_option': ({ sessionId, configId, value }) => {
    const s = session(sessionId);
    if (!(configId in s.config)) throw new RpcError(-32602, `Unknown config option: ${configId}`);
    s.config[configId] = value;
    return { configOptions: configOptions(s) };
  },
  'session/load': async (p) => {
    if (!PROFILE.loadSession) throw new RpcError(-32601, 'Method not found: session/load');
    const old = saved(p.sessionId);
    if (!old) throw new RpcError(-32602, `Unknown session: ${p.sessionId}`);
    // history first, as updates
    for (const h of old.history) {
      notify('session/update', {
        sessionId: p.sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: h.prompt } },
      });
      notify('session/update', {
        sessionId: p.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: h.reply } },
      });
    }
    return reopened(await openSession(p.sessionId, p, old.history));
  },
  'session/resume': async (p) => {
    if (!PROFILE.resume) throw new RpcError(-32601, 'Method not found: session/resume');
    const old = saved(p.sessionId);
    if (!old) throw new RpcError(-32602, `Unknown session: ${p.sessionId}`);
    return reopened(await openSession(p.sessionId, p, old.history));
  },
  'session/prompt': (p) => prompt(p),
  'session/close': ({ sessionId }) => (sessions.delete(sessionId), {}),
};

function onCancel({ sessionId }) {
  const run = sessions.get(sessionId)?.running;
  if (!run) return;
  // ignoreCancel: true never stops; a number ignores that many session/cancel first
  run.cancels = (run.cancels ?? 0) + 1;
  if (PROFILE.ignoreCancel === true || run.cancels <= (PROFILE.ignoreCancel || 0)) return;
  run.cancelled = true;
  run.wake?.();
}

async function handle(msg) {
  log({ kind: 'in', msg });
  if (!msg.method) {
    // a response to one of our requests
    const p = asked.get(msg.id);
    asked.delete(msg.id);
    if (p) msg.error ? p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data)) : p.resolve(msg.result);
    return;
  }
  if (msg.id == null) {
    if (msg.method === 'session/cancel') onCancel(msg.params || {});
    return;
  }
  const fn = handlers[msg.method];
  if (!fn) return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  try {
    send({ id: msg.id, result: await fn(msg.params || {}) });
  } catch (e) {
    send(errorReply(msg.id, e));
  }
}

lines(process.stdin, (msg) => void handle(msg));
process.stdin.on('end', () => {
  // FAKE_STAY: it does not notice that its parent went
  if (process.env.FAKE_STAY) return;
  for (const c of children) c.kill();
  process.exit(0);
});
