// Every way main makes a Claude Code or Codex chat saves its model and effort with it (electron/platform/chatStart.cjs),
// so a later pick in another chat, which moves the new-chat default, never reaches it. Found by method name: a new
// start or fork path is checked without editing this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatStarter } = require('../electron/platform/chatStart.cjs');

const CREATES = /^(start|fork)(Claude|Codex)$/;

test('each Claude Code and Codex chat main starts or forks keeps its own model and effort', async () => {
  const names = Object.getOwnPropertyNames(ChatStarter.prototype).filter((n) => CREATES.test(n));
  assert.ok(names.length >= 4, `found ${names.join(', ')}`);
  for (const name of names) {
    const metas = new Map<string, any>();
    const starter = new ChatStarter({
      prefs: () => ({ model: 'gpt-a', effort: 'low', claudeSelection: { model: 'sonnet', effort: 'low' } }),
      chats: { patchMeta: (id: string, meta: any) => (metas.set(id, { ...metas.get(id), ...meta }), true) },
      claudeSession: () => {},
      claudeFork: async () => ({ sessionId: 'copy' }),
      codexThread: async () => ({ id: 'codex-new' }),
      codexFork: async () => ({ id: 'codex-fork' }),
      started: () => {},
    });
    const id = name.startsWith('fork') ? await starter[name]('parent', '/work', null) : await starter[name]('/work', null);
    const config = metas.get(id)?.config;
    assert.ok(config && 'model' in config && 'effort' in config, `${name} saved ${JSON.stringify(config)}`);
  }
});
