// electron/platform/chatStart.cjs (#2139): a chat started with meta of its own (MoMo's tag) is tagged and every window
// told (chats:changed) before the chat is announced; meta that can't be saved stops the start before any window hears of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatStarter } = require('../electron/platform/chatStart.cjs');

function starter(patchMeta: (id: string, patch: any) => boolean) {
  const log: any[] = [];
  const s = new ChatStarter({
    prefs: () => ({ model: 'm' }),
    codexThread: async () => ({ id: 'th1' }),
    claudeSession: (...a: any[]) => log.push(['claude', ...a]),
    acpSession: (...a: any[]) => log.push(['acp', ...a]),
    chats: { patchMeta: (id: string, patch: any) => (log.push(['meta', id, patch]), patchMeta(id, patch)) },
    worktree: async () => ({ ok: false }),
    script: async () => ({ exitCode: 0, output: '' }),
    changed: (id: string) => log.push(['changed', id]),
    started: (e: any) => log.push(['started', e.chatId]),
  });
  return { s, log };
}

test('a chat started with meta of its own on any harness is tagged before it is announced', async () => {
  const { s, log } = starter(() => true);
  const claude = s.startClaude('/w', null, { meta: { momo: 'main' } });
  const acp = s.startAcp('kimi', '/w', '/repo', { meta: { momo: 'main' } });
  const codex = await s.startCodex('/w', null, { meta: { momo: 'main' } });
  assert.deepEqual(
    log.filter((l) => l[0] !== 'claude' && l[0] !== 'acp'),
    [
      ['meta', claude, { config: { model: null, effort: null }, momo: 'main' }],
      ['changed', claude],
      ['started', claude],
      ['meta', acp, { worktreeOf: '/repo', momo: 'main' }],
      ['changed', acp],
      ['started', acp],
      ['meta', codex, { config: { model: 'm', effort: null, serviceTier: null }, momo: 'main' }],
      ['changed', codex],
      ['started', codex],
    ],
  );
  // without meta of its own, a chat with nothing to write writes nothing; a Claude chat always saves its model and effort
  log.length = 0;
  s.startAcp('kimi', '/w', null);
  s.startClaude('/w', '/repo');
  assert.deepEqual(
    log.map((l) => l[0]),
    ['acp', 'started', 'claude', 'meta', 'changed', 'started'],
  );
});

test('meta or initial configuration that cannot be saved prevents announcement; a start with neither still works', async () => {
  const { s, log } = starter(() => false);
  assert.throws(() => s.startClaude('/w', null, { meta: { momo: 'main' } }), /Couldn't save the new chat's settings/);
  assert.throws(() => s.startAcp('kimi', '/w', null, { meta: { momo: 'main' } }), /Couldn't save/);
  await assert.rejects(s.startCodex('/w', null, { meta: { momo: 'main' } }), /Couldn't save/);
  assert.equal(log.filter((l) => l[0] === 'started').length, 0);
  // Codex always keeps its own initial configuration, even without caller-provided metadata.
  await assert.rejects(s.startCodex('/w', null), /Couldn't save/);
  assert.equal(log.filter((l) => l[0] === 'started').length, 0);
  s.startAcp('kimi', '/w', null);
  assert.equal(log.at(-1)[0], 'started');
});
