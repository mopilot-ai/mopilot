// The MCP gateway (electron/gateway/service.cjs, offer.cjs) over real sealed files (a fake safeStorage), main's real tool Registry and in-process MCP servers (the SDK's own Server over its linked in-memory transport), for the gateway tests: each server's tools are set by the test and can change (with the list-changed notification), every connect records the launch and credential the gateway used, and the card is the test's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createRequire } from 'node:module';
import { fakeSafe } from './momo-fixtures.ts';
import { fakeServer, tick, READ } from './momoMcpWorld.ts';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Gateway } = require('../../electron/gateway/service.cjs');
const { GatewayOffer } = require('../../electron/gateway/offer.cjs');
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');

export { fakeServer, tick, READ };

/** A scratch gateway folder, removed after the file's tests. */
export function gatewayDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'gateway');
}

export const stdio = (name: string, command = name) => ({ name, launch: { type: 'stdio', command, args: [], env: {} } });
export const http = (name: string, url: string, auth = 'none') => ({ name, launch: { type: 'http', url, headers: {} }, auth });

/**
 * @param o servers: fake servers by the launch's command or URL; ask: the card's answer (default allow)
 */
export function gatewayWorld(
  o: {
    servers?: Record<string, any>;
    ask?: (chatId: string, signal: AbortSignal, card: any) => Promise<any>;
    dir?: string;
    safe?: any;
    askMs?: number;
    policy?: any;
  } = {},
) {
  const servers: Record<string, any> = o.servers ?? {};
  const s: any = { connects: [] as any[], closed: 0, gate: null as null | Promise<void>, connectError: null, cards: [] as any[] };
  const safe = o.safe ?? fakeSafe();
  const dir = o.dir ?? gatewayDir();
  const gateway = new Gateway({
    dir,
    safeStorage: safe,
    now: () => 1000,
    connect: async (launch: any, opts: any) => {
      s.connects.push({ launch, ...opts });
      if (s.gate) await s.gate;
      if (s.connectError) throw s.connectError;
      const srv = servers[launch.type === 'stdio' ? launch.command : launch.url];
      if (!srv) throw Object.assign(new Error('no such server'), { code: 'ENOENT' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await srv.make().connect(st);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(ct);
      const close = client.close.bind(client);
      client.close = async () => (s.closed++, s.lazyClose ? undefined : close());
      // every notification handler the gateway sets, to fire one by hand (a notice of a client already stopped)
      const set = client.setNotificationHandler.bind(client);
      client.setNotificationHandler = (schema: any, fn: any) => ((s.handlers ??= []).push(fn), set(schema, fn));
      return client;
    },
  });
  const registry = new Registry();
  const momo = new Set(['momo-chat']);
  const offer = new GatewayOffer({
    upstreams: gateway.upstreams,
    registry,
    owner: (ctx: any) => ctx?.chatId ?? null,
    visible: (chatId: string) => !momo.has(chatId),
    askMs: o.askMs,
    ...(o.policy ? { policy: o.policy } : {}),
    ask: async (chatId: string, signal: AbortSignal, card: any) => {
      s.cards.push({ chatId, card, signal });
      return o.ask ? o.ask(chatId, signal, card) : { decision: 'allow', choice: 'allow' };
    },
  });
  /** Calls a tool as chat `chatId` would, through the Registry. */
  const call = (name: string, args: any = {}, chatId = 'chat-1') => registry.invoke(chatId, 'seg-1', name, args);
  const names = (chatId = 'chat-1') => registry.list({ chatId }).map((t: any) => t.name);
  return { gateway, registry, offer, s, servers, call, names, safe, dir };
}
