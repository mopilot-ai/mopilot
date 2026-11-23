// Whole-repository rule (#2278): every harness MoMo can run on keeps its own tools and instructions out of MoMo's chats.
// Each family MoMo starts chats on is listed with how it is confined, and every ACP harness the app knows either has an
// isolation quirk (its confined process) or is refused as MoMo's brain, by MoMo's menus and by the ACP host. A new
// family or a new ACP quirks file fails here until it says which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { START } = require('../electron/momo/mainChat.cjs');
const { assertConfinable } = require('../electron/momo/apart.cjs');
const { harnessKinds } = require('../electron/app/momo.cjs');
const quirks = require('../electron/harness/quirks/index.cjs');
const { AcpHost } = require('../electron/harness/acp.cjs');
const { setup } = await import('./support/acp-host/fixture.ts');

/** How each family's MoMo chat is confined, checked below where it can be from here. */
const CONFINED_BY = {
  codex: 'its thread starts isolated (harness/codexIsolation.cjs: tools off, strictest sandbox, memory off)',
  claude: 'the session options of a MoMo chat (harness/claude/isolation.cjs: no CLAUDE.md, no memory, no built-in tools)',
  acp: "a confined process per harness from its isolation quirk (harness/acp/isolation.cjs); a harness without one can't be MoMo's",
};

test('every family MoMo starts chats on says how it is confined', async () => {
  assert.deepEqual(Object.keys(START).sort(), Object.keys(CONFINED_BY).sort());
  // Codex: the start itself asks for an isolated thread
  const calls: any[] = [];
  await START.codex({ startCodex: (...a: any[]) => (calls.push(a), 'th') }, '/w', null, { momo: 'main' });
  assert.deepEqual(calls, [['/w', null, { meta: { momo: 'main' }, isolated: true }]]);
});

test('every ACP harness the app knows is confined by its quirks or refused as MoMo’s brain, by the menus and the host', async () => {
  const all = quirks.ids({
    packaged: false,
    env: { MOPILOT_FLAGS: 'harness.acp.claude-acp.enabled=true,harness.acp.codex-acp.enabled=true' },
  });
  assert.ok(all.includes('opencode') && all.includes('claude-acp') && all.includes('codex-acp'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-confined-'));
  const admitted = { list: () => all.map((id: string) => ({ id, state: 'admitted' })) };
  const kinds = harnessKinds(admitted);
  for (const id of all) {
    const q = quirks.quirks(id);
    assert.deepEqual(quirks.validate(q), [], id);
    if (q.isolation) {
      assert.ok(kinds.includes(`acp:${id}`), id);
      assertConfinable(`acp:${id}`, id, { OPENAI_API_KEY: 'k' });
      continue;
    }
    assert.ok(!kinds.includes(`acp:${id}`), `${id} is not offered for MoMo`);
    assert.throws(() => assertConfinable(`acp:${id}`, id), { code: 'unconfined' }, id);
    // the host refuses an isolated chat on it before anything starts
    const host = new AcpHost({ items: { readAsync: async () => [] }, quirks: () => q, resolveBin: () => '/bin/x', pty: {} });
    host.isolated = () => true;
    await assert.rejects(host.ensure(`acp:${id}:c`, { cwd: ws }), /can't run MoMo's chats/, id);
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

// A chat calls only its own MoPilot tool server (#2302): Claude Code runs one CLI per chat with its own servers,
// Codex gives each thread its own config fragment (capabilities/channels/codexConfig.cjs), and an ACP agent may share
// the servers of every session it holds in one folder, so a MoMo chat on ACP holds a process alone.
test('no two MoMo chats on an ACP harness share a process', async () => {
  const q = { label: 'Fake', args: ['acp'], isolation: { env: () => ({}), mode: { mode: 'm' } } };
  const t = setup({
    quirks: () => q,
    handlers: { 'session/new': () => ({ sessionId: 's', modes: { currentModeId: 'm', availableModes: [{ id: 'm' }] } }) },
  });
  t.host.isolated = () => true;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-own-'));
  const chats = await Promise.all(['a', 'b', 'c'].map((id) => t.host.ensure(`acp:fake:${id}`, { cwd: ws })));
  assert.equal(new Set(chats.map((c: any) => c.agent)).size, chats.length);
  t.host.closeAll();
  fs.rmSync(ws, { recursive: true, force: true });
});
