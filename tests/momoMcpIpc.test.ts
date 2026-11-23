// The coding tools' IPC (electron/momo/mcp/ipc.cjs, #2999 C0) over a real proxy and in-process MCP servers: list, Allow, a tool on and off, every channel refused while MoMo is not allowed, Remove included; failures typed by the proxy's code; no OS key lists nothing and says so; a change broadcast only while MoMo is allowed; the remover takes everything away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mcpWorld, fakeServer, READ } from './support/momoMcpWorld.ts';

const require = createRequire(import.meta.url);
const { registerMcpIpc, CHANNELS, NOT_ALLOWED } = require('../electron/momo/mcp/ipc.cjs');
const { SealedUnavailableError } = require('../electron/gateway/sealedFile.cjs');

function wire(proxy: any, allowed: () => boolean) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const sent: string[] = [];
  const ipcMain = { handle: (c: string, fn: any) => void handlers.set(c, fn), removeHandler: (c: string) => void handlers.delete(c) };
  const off = registerMcpIpc(ipcMain, { proxy, allowed, broadcast: (c: string) => void sent.push(c) });
  return { handlers, sent, off, call: (c: string, ...a: any[]) => handlers.get(c)!({}, ...a) };
}

test('list, allow, a tool off, remove; refused while MoMo is not allowed but Remove; broadcast only while allowed', async () => {
  const w = mcpWorld({ servers: { notes: fakeServer([{ name: 'notes_list', inputSchema: READ, annotations: { readOnlyHint: true } }]) } });
  w.attach();
  const i = wire(w.proxy, () => w.s.allowed);
  assert.deepEqual([...i.handlers.keys()], [...CHANNELS]);
  assert.deepEqual(
    (await i.call('momoMcp:list')).servers.map((s: any) => [s.key, s.allowed]),
    [['claude:notes', false]],
  );
  assert.deepEqual(await i.call('momoMcp:allow', 'claude:notes'), { ok: true });
  const tool = (await i.call('momoMcp:list')).servers[0].tools[0];
  assert.equal(tool.on, true);
  assert.deepEqual(await i.call('momoMcp:setTool', 'claude:notes', tool.key, false), { ok: true });
  assert.equal(w.tools.size, 0);
  assert.equal((await i.call('momoMcp:allow', 'claude:nope')).reason, 'unknown');
  assert.ok(i.sent.length > 0 && i.sent.every((c) => c === 'momoMcp:changed'));
  i.sent.length = 0;
  w.s.allowed = false;
  for (const c of CHANNELS) assert.deepEqual(await i.call(c, 'claude:notes'), NOT_ALLOWED);
  assert.notEqual(w.allowlist.get('claude:notes'), null, 'nothing was removed');
  assert.deepEqual(i.sent, []);
  w.s.allowed = true;
  i.off();
  assert.equal(i.handlers.size, 0);
  await w.proxy.remove('claude:notes');
  assert.deepEqual(i.sent, []);
});

test('list: no OS key lists nothing and says so; another failure, or a plain one from elsewhere, is a typed failure', async () => {
  const fake = (list: () => any) => Object.assign(new EventEmitter(), { list });
  const none = wire(
    fake(async () => {
      throw new SealedUnavailableError();
    }),
    () => true,
  );
  assert.deepEqual(await none.call('momoMcp:list'), { ok: true, servers: [], available: false });
  const broken = wire(
    fake(async () => {
      throw new Error('disk gone');
    }),
    () => true,
  );
  assert.deepEqual(await broken.call('momoMcp:list'), { ok: false, error: 'disk gone' });
});
