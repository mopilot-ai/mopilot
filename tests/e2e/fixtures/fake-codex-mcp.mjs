// MCP child configuration, calls and interruptible tool items for the scripted Codex fixture.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { callLines } from './fake-cu-calls.mjs';
import { fakeControlText } from './fake-control-text.mjs';

export function createFakeCodexMcp({ version, log, notify, waiting }) {
  const VERSION = version;
  /** A running stdio MCP server: initialize, then request(). */
  function mcpClient(cfg) {
    const env = { ...process.env, ...(cfg.env || {}) };
    const child = spawn(cfg.command, cfg.args || [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let next = 1;
    let buf = '';
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          pending.get(m.id)?.(m);
          pending.delete(m.id);
        } catch {
          /* ignore a non-JSON line from the peer */
        }
      }
    });
    const gone = new Promise((r) => child.on('exit', (code) => r({ error: { message: `exited (${code}) ${stderr.trim()}` } })));
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    const request = (method, params) =>
      Promise.race([
        gone,
        new Promise((resolve) => {
          const id = next++;
          pending.set(id, resolve);
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        }),
      ]);
    const ready = request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-codex', version: VERSION },
    }).then((r) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    });
    return { child, ready, request, kill: () => child.kill() };
  }

  /** Takes a thread's MCP servers from start/resume config, replacing (and stopping) the old ones. */
  function useMcpConfig(rec, config) {
    const servers = config?.mcp_servers;
    if (!servers) return;
    for (const c of rec.mcp?.values() ?? []) c.kill();
    rec.mcp = new Map();
    rec.mcpConfig = servers;
    for (const [name, cfg] of Object.entries(servers)) if (cfg.command) rec.mcp.set(name, mcpClient(cfg));
  }

  /** Calls sage_debug_echo on each of the thread's MCP servers; one answer per server. */
  async function callMcp(rec, threadId, word) {
    const out = [];
    for (const [name, client] of rec.mcp ?? []) {
      const init = await client.ready;
      if (init.error) {
        log({ kind: 'mcp', threadId, server: name, error: init.error.message });
        out.push(`${name}: ${init.error.message}`);
        continue;
      }
      const listed = await client.request('tools/list', {});
      const tool = listed.result?.tools?.find((t) => t.name === 'sage_debug_echo');
      const approved = rec.mcpConfig[name].default_tools_approval_mode === 'approve' || tool?.annotations?.readOnlyHint === true;
      let text;
      if (!tool) text = 'no sage_debug_echo';
      else if (!approved) text = 'MCP tool call requires approval, but approval policy is never';
      else {
        const res = await client.request('tools/call', { name: 'sage_debug_echo', arguments: { text: word } });
        text = res.result?.content?.map((c) => c.text).join(' ') ?? res.error?.message;
      }
      log({
        kind: 'mcp',
        threadId,
        server: name,
        serverInfo: init.result?.serverInfo ?? null,
        tools: listed.result?.tools?.map((t) => t.name) ?? [],
        text,
      });
      out.push(`${name}: ${text}`);
    }
    return out;
  }

  /**
   * The "MCPCU <tool> <json>" lines of a prompt, run in order on the thread's sage_<nonce> server as Codex runs MCP calls:
   * an mcpToolCall item each, started and completed. Returns the answers for the reply and whether an interrupt ended
   * the turn (the call in flight is then left unanswered). A Stop that lands after the calls, while the caller writes
   * the reply, sets `interrupted` on the returned object: a real model's turn ends whenever the Stop reaches it, and the
   * Stop of an app's batch cancels the call and interrupts the turn together, in either order (#4704). The hook stays in
   * `waiting` until that Stop or the turn's own SLOW wait takes its place.
   */
  async function callHostTools(rec, turn, threadId, turnId, text, { scriptedGoal = false } = {}) {
    const calls = callLines(scriptedGoal ? text : fakeControlText(text), 'MCPCU');
    const entry = [...(rec.mcp ?? new Map())].find(([name]) => /^sage_[0-9a-f]{12}$/.test(name));
    if (!calls.length) return { text: '', interrupted: false };
    /** @param {string} text @param {boolean} interrupted */
    const finish = (text, interrupted) => {
      const result = { text, interrupted };
      if (!interrupted) waiting.set(turnId, () => (result.interrupted = true));
      return result;
    };
    if (!entry) return finish(' [cu: no sage server]', false);
    const [server, client] = entry;
    let interrupted = false;
    const cut = new Promise((resolve) => waiting.set(turnId, () => ((interrupted = true), resolve('cut'))));
    let out = '';
    await client.ready;
    for (const [, tool, json] of calls) {
      if (interrupted) break;
      const args = JSON.parse(json);
      /** @type {{
       * type: 'mcpToolCall', id: string, server: string, tool: string, status: string, arguments: unknown,
       * appContext: null, result: {content: any[], structuredContent: null} | null,
       * error: {message: string} | null, durationMs: number | null
       * }} */
      const item = {
        type: 'mcpToolCall',
        id: randomUUID(),
        server,
        tool,
        status: 'inProgress',
        arguments: args,
        appContext: null,
        result: null,
        error: null,
        durationMs: null,
      };
      turn.items.push(item);
      const started = Date.now();
      notify('item/started', { item: { ...item }, threadId, turnId, startedAtMs: started });
      const res = await Promise.race([client.request('tools/call', { name: tool, arguments: args }), cut]);
      if (res === 'cut') {
        item.status = 'failed';
        item.error = { message: 'interrupted' };
        out += ' [cu: interrupted]';
      } else {
        const content = res.result?.content ?? [];
        const said = content.map((c) => (c.type === 'image' ? '<image>' : c.text)).join(' ') || res.error?.message || 'no answer';
        item.status = res.result && !res.result.isError ? 'completed' : 'failed';
        if (res.result) item.result = { content, structuredContent: null };
        else item.error = { message: said };
        out += ` [cu: ${res.result?.isError ? 'error: ' : ''}${said}]`;
      }
      item.durationMs = Math.max(1, Date.now() - started);
      notify('item/completed', { item: { ...item }, threadId, turnId, completedAtMs: Date.now() });
    }
    return finish(out, interrupted);
  }

  return { useMcpConfig, callMcp, callHostTools };
}
