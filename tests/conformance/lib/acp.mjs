// The ACP client side of the conformance checks, shared by acp/probe.mjs (the installed harnesses) and
// acp/contract.test.ts (the fake agent that mimics each harness): MoPilot's own ACP adapter,
// admission probe and sage-mcp tool channel, the launcher that stands in for an installed binary, and
// the turn helpers. Nothing here talks to a model; a probe sends no prompt.
import fs from 'node:fs';
import { readJsonLineLog } from '../../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from './common.mjs';
import { acpFixtureStop, acpFixtureProcesses } from '../../support/acp-fixture-stop.mjs';

const require = createRequire(import.meta.url);
const load = (p) => require(path.join(REPO, p));

/** tests/fixtures/fake-acp-agent.mjs: the scripted agent a launcher runs. */
export const AGENT = path.join(REPO, 'tests/fixtures/fake-acp-agent.mjs');

/** @type {any} the app's modules, once loaded */
let appCache = null;

/** The app's own modules the ACP checks run through (loaded once, on first use). @returns {any} */
export function app() {
  return (appCache ??= {
    acp: load('electron/harness/acp.cjs'),
    isSageToolCall: load('electron/harness/acp/clientMethods.cjs').isSageToolCall,
    probe: load('electron/harness/admission.cjs').probe,
    quirks: load('electron/harness/quirks/index.cjs'),
    ItemsLog: load('electron/platform/chats.cjs').ItemsLog,
    pty: load('electron/platform/pty.cjs'),
    shellEnv: load('electron/platform/env.cjs'),
    ToolSessions: load('electron/capabilities/contract/session.cjs').ToolSessions,
    Registry: load('electron/capabilities/contract/registry.cjs').Registry,
    ToolSocket: load('electron/capabilities/mcp/socket.cjs').ToolSocket,
    sageMcpPath: load('electron/capabilities/mcp/socket.cjs').sageMcpPath,
    SessionMcp: load('electron/capabilities/channels/sessionMcp.cjs').SessionMcp,
    ToolHttp: load('electron/capabilities/httpMcp.cjs').ToolHttp,
    echo: load('electron/capabilities/tools/debug.cjs').echo,
  });
}

/**
 * The tool channel basic harnesses get in session/new, as the app builds it (electron/app/agentTools.cjs): a session
 * registry, the socket sage-mcp connects to, main's http endpoint for a harness that takes no stdio MCP server
 * (Copilot CLI), and the SessionMcp that hands out the mcpServers entry and waits for the hello.
 * @param {{ echo?: boolean, verifyPeer?: Function }} [o] echo: register sage_debug_echo, the tool the contract
 *   scenarios call; verifyPeer: the http endpoint's check of the connecting process (the app's lsof check by default)
 * @returns {{ channel: object, socket: object, http: object, close: () => void }}
 */
export function toolChannel({ echo = false, verifyPeer } = {}) {
  const { ToolSessions, ToolSocket, ToolHttp, Registry, SessionMcp, sageMcpPath, echo: echoTool } = app();
  const sessions = new ToolSessions();
  const registry = new Registry();
  if (echo) registry.register(echoTool);
  const socket = new ToolSocket({ sessions, registry });
  const http = new ToolHttp({ sessions, registry, ...(verifyPeer ? { verifyPeer } : {}) });
  const channel = new SessionMcp({ sessions, socket, http, command: sageMcpPath() });
  return {
    channel,
    socket,
    http,
    close: () => {
      socket.close();
      http.close();
    },
  };
}

/** A throwaway folder (realpath, so cwd comparisons hold). */
export const tempDir = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/**
 * The harness "as installed": a launcher script under its bin name that runs the fake agent with its
 * profile (what it declares). `agentLog()` reads what the agent saw and wrote.
 */
export function installFake(dir, id, profile, name = id) {
  const home = path.join(dir, name);
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(home, 'agent.jsonl');
  const bin = path.join(home, app().quirks.quirks(id).bins[0]);
  const vars = { FAKE_ACP_LOG: log, FAKE_ACP_STATE: path.join(home, 'state'), FAKE_ACP_PROFILE: JSON.stringify(profile) };
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n${Object.entries(vars)
      .map(([k, v]) => `export ${k}='${v}'`)
      .join('\n')}\nexec "${process.execPath}" "${AGENT}" "$@"\n`,
    { mode: 0o755 },
  );
  const agentLog = () => readJsonLineLog(log);
  return { home, bin, agentLog, dataDir: path.join(home, 'userData'), items: path.join(home, 'threads') };
}

/** The admission probe, as the app runs it, against the fake installed by installFake. */
export async function probeFake(id, inst, tools) {
  const { probe, quirks } = app();
  const owned = acpFixtureProcesses(load('electron/harness/acp/agent.cjs').spawn);
  try {
    return await probe(id, {
      quirks: quirks.quirks,
      resolveBin: () => inst.bin,
      env: () => process.env,
      tools,
      dataDir: inst.dataDir,
      spawnFn: owned.spawn,
    });
  } finally {
    await owned.stop();
  }
}

/**
 * An AcpHost over one installed fake. Every permission card is answered with its allow_once option
 * after a few ms, as a user clicking Allow would. `events` collects what the host emits.
 */
export function openHost({ id, inst, tools, cwd, admitted = () => null, hosts }) {
  const { acp, ItemsLog, quirks, pty } = app();
  const events = [];
  const h = new acp.AcpHost({
    items: new ItemsLog(inst.items),
    quirks: quirks.quirks,
    ids: quirks.ids(),
    resolveBin: (x) => (x === id ? inst.bin : null),
    env: () => process.env,
    tools,
    pty,
    cwd,
    dataDir: inst.dataDir,
    admitted,
  });
  hosts?.push(h);
  h.on('event', (e) => {
    events.push(e);
    if (e.kind === 'permission') setTimeout(() => h.permission(e.requestId, e.options.find((o) => o.kind === 'allow_once')?.optionId), 5);
  });
  return { h, events, stop: acpFixtureStop(h) };
}

/** Polls until `fn` returns something truthy; throws after `ms`. */
export async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The text the agent streamed in a turn. */
export const said = (events, turnId) =>
  events
    .filter((e) => e.kind === 'update' && e.turnId === turnId && e.update.sessionUpdate === 'agent_message_chunk')
    .map((e) => e.update.content.text)
    .join('');

/** One prompt, to the end of its turn: { turnId, end, reply }. */
export async function turn(h, events, key, cwd, text) {
  const { turnId } = await h.send(key, { cwd, blocks: [{ type: 'text', text }], display: [] }, {});
  const end = await until(() => events.find((e) => e.kind === 'turnEnd' && e.turnId === turnId));
  return { turnId, end, reply: said(events, turnId) };
}

/**
 * The admission probe of each installed basic harness, as the app runs it: the quirks' privacy check,
 * initialize, session/new with a sage_<nonce> server in a temp folder (main's http endpoint for a harness that takes
 * no stdio MCP server), and its hello. No prompt is
 * sent. Writes `<outDir>/<id>@<version>.json` for each one found and calls `onResult(id, result)`.
 */
export async function probeInstalled(ids, { outDir, onResult = (/** @type {string} */ _id, /** @type {any} */ _r) => {} }) {
  const { probe, quirks, shellEnv } = app();
  await shellEnv.init();
  const { channel, close } = toolChannel();
  // the probe's own data folder (dsh's patch), never the app's
  const dataDir = tempDir('mopilot-acp-probe-data-');
  try {
    for (const id of ids?.length ? ids : quirks.ids()) {
      const r = await probe(id, {
        quirks: quirks.quirks,
        resolveBin: (x) => quirks.findBin(x, (b) => shellEnv.which(b)),
        env: () => shellEnv.childEnv(),
        tools: channel,
        dataDir,
      });
      onResult(id, r);
      if (r.state === 'missing') continue;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, `${id}@${r.version ?? 'unknown'}.json`),
        JSON.stringify({ ...r, bin: path.basename(r.bin ?? '') }, null, 2) + '\n',
      );
    }
  } finally {
    close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
