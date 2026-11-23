// The fake ACP agent's side of MCP (tests/fixtures/fake-acp-agent.mjs): newline-delimited JSON, and the stdio and
// http MCP servers a session is given, connected as a harness connects them, and the prompt words that call their tools.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { groupOf, SURFACES } from '../../electron/capabilities/mcp/toolTiers.cjs';

const VERSION = '0.0.0-fake';
const MCP_TIMEOUT_MS = 5000;

/** Reads newline-delimited JSON from a stream. */
export function lines(stream, onMessage) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  });
}

export const children = new Set();

/** Spawns a stdio MCP server and runs initialize, notifications/initialized and tools/list. */
export function connectMcp(server, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const { name, value } of server.env || []) env[name] = value;
    let child;
    try {
      child = spawn(server.command, server.args || [], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      return resolve({ ok: false, error: String(e.message || e) });
    }
    children.add(child);
    child.on('exit', () => children.delete(child));
    const pending = new Map();
    const call = (id, method, params) =>
      new Promise((res, rej) => {
        pending.set(id, { res, rej });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    lines(child.stdout, (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    });
    const timer = setTimeout(() => done({ ok: false, error: 'timed out' }), MCP_TIMEOUT_MS);
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on('error', (e) => done({ ok: false, error: String(e.message || e) }));
    child.on('exit', (code) => done({ ok: false, error: `exited (${code})` }));
    child.stdin.on('error', () => {});
    (async () => {
      const init = await call(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-acp', version: VERSION },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const listed = await call(2, 'tools/list', {});
      let next = 3;
      const r = { ok: true, serverInfo: init?.serverInfo ?? null, tools: (listed?.tools || []).map((t) => t.name) };
      // kept for later tools/call, out of the log
      Object.defineProperty(r, 'call', { value: (method, params) => call(next++, method, params), enumerable: false });
      done(r);
    })().catch((e) => done({ ok: false, error: String(e.message || e) }));
  });
}

/**
 * Connects an http MCP server (Streamable HTTP, answered with JSON) and runs initialize, notifications/initialized
 * and tools/list, sending the headers it was given.
 */
export async function connectHttpMcp(server) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const { name, value } of server.headers || []) headers[name] = value;
  let next = 1;
  const post = async (body) => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
    if (res.status === 202) return null;
    const m = await res.json();
    if (m.error) throw new Error(m.error.message);
    return m.result;
  };
  const call = (method, params) => post({ id: next++, method, params });
  try {
    const init = await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-acp', version: VERSION },
    });
    await post({ method: 'notifications/initialized' });
    const listed = await call('tools/list', {});
    const r = { ok: true, serverInfo: init?.serverInfo ?? null, tools: (listed?.tools || []).map((t) => t.name) };
    Object.defineProperty(r, 'call', { value: call, enumerable: false });
    return r;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * The tool calls a prompt asks for: each "MCPTOOL <name> <json>" line, then each of the profile's `onPrompt` entries
 * ({ match, tool, args }) whose `match` the prompt holds, as a harness's model would call a tool its prompt names (a MoMo
 * routine run's momo_memory_save); "$CHAT" in its args is the first chat id the prompt quotes ("chat":"<id>"). Each is
 * [whole, tool, json] as the agent's MCPTOOL loop reads it.
 * @param {string} text @param {{ onPrompt?: { match: string, tool: string, args: object }[] }} profile
 */
export function toolCalls(text, profile) {
  const asked = [...text.matchAll(/MCPTOOL (\S+) (\S+)/g)];
  const chat = /"chat":"([^"]+)"/.exec(text)?.[1] ?? '';
  const own = (profile.onPrompt ?? [])
    .filter((c) => text.includes(c.match))
    .map((c) => ['', c.tool, JSON.stringify(c.args).replaceAll('$CHAT', chat)]);
  return [...asked, ...own];
}

/**
 * The prompt's MCP words, run on the session's connected MCP servers (`servers`: name -> connection), and what the reply
 * says about them: MCPCALL <w> calls sage_debug_echo on each; MCPTOOL <name> <json> calls that tool on the server that
 * lists it, or through that session's advertised more tool, as a call titled as opencode titles one (<server>_<tool>).
 */
export async function mcpWords(text, servers, { update, log, sessionId, profile = {} }) {
  let out = '';
  const mcpCall = /MCPCALL (\S+)/.exec(text);
  if (mcpCall)
    for (const [name, server] of servers) {
      const res = await server
        .call('tools/call', { name: 'sage_debug_echo', arguments: { text: mcpCall[1] } })
        .catch((e) => ({ content: [{ type: 'text', text: String(e.message || e) }] }));
      const said = (res?.content || []).map((c) => c.text).join(' ');
      log({ kind: 'mcpCall', sessionId, name, text: said });
      out += ` [mcp ${name}: ${said}]`;
    }
  for (const [, tool, json] of toolCalls(text, profile)) {
    let [serverName, server] = [...servers.entries()].find(([, m]) => m.tools?.includes(tool)) ?? [];
    let called = tool;
    if (!server) {
      // A model runs a deferred tool now through the advertised more tool, without waiting for another turn.
      const surface = groupOf(tool)?.surface;
      const more = surface && SURFACES[surface].more;
      if (more) {
        [serverName, server] = [...servers.entries()].find(([, m]) => m.tools?.includes(more)) ?? [];
        if (server) called = more;
      }
    }
    const input = server ? JSON.parse(json) : null;
    const args = called === tool ? input : { call: tool, arguments: input };
    // a step titled as opencode titles an MCP tool: its server and tool joined by "_" (sage_<nonce>_<tool>)
    const toolCallId = `call-${randomUUID()}`;
    if (server)
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `${serverName}_${called}`,
        kind: 'other',
        status: 'in_progress',
        rawInput: args,
      });
    const res = server
      ? await server
          .call('tools/call', { name: called, arguments: args })
          .catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] }))
      : { content: [{ type: 'text', text: `no server lists ${tool}` }] };
    const said = (res?.content || []).map((c) => c.text).join(' ');
    log({ kind: 'mcpTool', sessionId, tool, text: said });
    if (server)
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: res?.isError ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: said } }],
      });
    out += ` [${tool}: ${said}]`;
  }
  return out;
}
