// An MCP proxy (electron/momo/mcp/proxy.cjs) over a real allowlist and in-process MCP servers (the SDK's own Server over its linked in-memory transport) for the MoMo MCP tests: each server's tools are set by the test and can change (with the list-changed notification), every call's decision and audit entry is recorded, and a fake registry stands in for main's (its tools listed, called as a MoMo chat's segment would).
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './momo-fixtures.ts';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { McpProxy } = require('../../electron/momo/mcp/proxy.cjs');
const { McpAllowlist } = require('../../electron/momo/mcp/allowlist.cjs');

export const tick = () => new Promise((r) => setImmediate(r));
export const READ = { type: 'object', properties: {} };

/** A fake MCP server: `tools` and `answer` are the test's; `changed()` sends the list-changed notification. */
export function fakeServer(tools: any[] = []) {
  const s: any = { tools, calls: [] as any[], answer: async (_req: any) => ({ content: [{ type: 'text', text: 'ok' }] }) };
  s.make = () => {
    const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: s.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => (s.calls.push(req.params), s.answer(req)));
    s.server = server;
    return server;
  };
  s.changed = () => s.server.sendToolListChanged();
  return s;
}

/** A catalog entry for a fake server. */
export const entry = (name: string, origin = 'claude') => ({
  key: `${origin}:${name}`,
  name,
  origin,
  from: 'Claude Code',
  launch: { type: 'stdio', command: 'fake', args: [], env: {} },
});

export function mcpWorld(o: { servers?: Record<string, any>; decide?: (c: any) => Promise<any>; noTrust?: boolean } = {}) {
  const servers: Record<string, any> = o.servers ?? { notes: fakeServer() };
  const catalog = Object.keys(servers).map((n) => entry(n));
  const allowlist = new McpAllowlist({ dir: scratch(), safeStorage: fakeSafe(), now: () => 1 });
  const decisions: any[] = [];
  const audits: any[] = [];
  const s: any = { allowed: true, catalogReads: 0, gate: null as null | Promise<void>, connects: 0, closed: 0 };
  const proxy = new McpProxy({
    catalog: async () => (s.catalogReads++, catalog),
    allowlist,
    allowed: () => s.allowed,
    decide: o.noTrust ? null : async (c: any) => (decisions.push(c), o.decide ? o.decide(c) : { allow: true }),
    audit: o.noTrust ? null : { append: (e: any) => void audits.push(e) },
    connect: async (launch: any) => {
      s.connects++;
      if (s.gate) await s.gate;
      if (s.connectError) throw s.connectError;
      const name = catalog.find((e) => e.launch === launch)!.name;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await servers[name].make().connect(st);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(ct);
      const close = client.close.bind(client);
      // lazyClose: the connection stays up after close(), so a listing or a call already sent still answers
      client.close = async () => (s.closed++, s.lazyClose ? undefined : close());
      // every notification handler the proxy sets, to fire one by hand (a notice of a client already stopped)
      const set = client.setNotificationHandler.bind(client);
      client.setNotificationHandler = (schema: any, fn: any) => ((s.handlers ??= []).push(fn), set(schema, fn));
      return client;
    },
  });
  const tools = new Map<string, any>();
  const registry = {
    register: (t: any) => {
      if (tools.has(t.name)) throw new Error(`tool ${t.name} is already registered`);
      tools.set(t.name, t);
      return () => tools.delete(t.name);
    },
  };
  const momoChats = new Set(['mc']);
  const attach = () => proxy.attach({ registry, isMomoChat: (id: string) => momoChats.has(id), owner: (ctx: any) => ctx?.chatId ?? null });
  /** Calls a registered tool as chat `chatId`'s segment would. */
  const call = (name: string, args: any = {}, chatId = 'mc') => {
    const t = tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.handler(args, { chatId, segmentId: 's' });
  };
  return { proxy, allowlist, decisions, audits, s, tools, servers, attach, call, catalog };
}
