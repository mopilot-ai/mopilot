// Native creation transfers a prepared worktree to the chat lifecycle before cancellation or partial failure can remove it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, tick } from './support/controller/fixture.ts';
import { orchestration } from './support/orchestration-harness.ts';
import { deferred } from './support/async-scenarios.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { ChatStarter } = require('../electron/platform/chatStart.cjs');
const { discardPrepared } = require('../electron/session/orchestration/preparedChild.cjs');
const { makeChild } = require('../electron/session/orchestration/spawn.cjs');
const { worktreeRestore } = require('../electron/platform/git.cjs');
const { registerChats } = require('../electron/platform/chats.cjs');
const { discardWorktree } = require('../electron/platform/discardWorktree.cjs');

const modes = ['codex', 'claude', 'acp:kimi', 'codex-fork', 'claude-fork'];

function fixture(t: any, mode: string, native: (id: string) => any = () => undefined) {
  const f = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-native-'));
  const cwd = path.join(root, 'holder', 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(path.dirname(f.chats.dir), { recursive: true, force: true }));
  const kind = mode.replace('-fork', '');
  const id = kind === 'claude' ? 'claude:child' : kind === 'codex' ? 'child' : 'acp:kimi:child';
  const removals: any[] = [];
  const start = () => {
    f.chats.ensure(id);
    return native(id);
  };
  const starter = new ChatStarter({
    prefs: () => ({}),
    chats: f.chats,
    worktree: async () => ({ ok: true, path: cwd, worktree: cwd, repo: root }),
    discardWorktree: (wt: any) =>
      discardWorktree(wt, {
        run: async (...args: any[]) => {
          removals.push(args);
          fs.rmSync(cwd, { recursive: true, force: true });
          return { ok: true };
        },
      }),
    codexThread: async () => {
      await start();
      return { id };
    },
    codexFork: async () => {
      await start();
      return { id };
    },
    claudeSession: () => start(),
    claudeFork: async () => {
      await start();
      return { sessionId: 'child' };
    },
    acpSession: () => start(),
    started: () => undefined,
  });
  const h = orchestration({ projectOf: async () => root });
  h.orch.o.starter = starter;
  h.orch.o.controller = f.c;
  h.orch.o.chats = f.chats;
  h.orch.o.childOptions = async () => ({ model: 'child-model' });
  h.orch.o.archive = (chat: string) => f.chats.patchMeta(chat, { archived: 1000 });
  f.chats.ensure('parent');
  f.chats.setSegments('parent', [{ harness: kind, nativeId: 'parent', start: 0, count: null }]);
  const handlers = new Map<string, (...args: any[]) => any>();
  registerChats(
    { handle: (key: string, handler: any) => handlers.set(key, handler) },
    {
      store: f.chats,
      uiState: path.join(root, 'ui.json'),
      broadcast: () => undefined,
    },
  );
  const args = { context: mode.endsWith('-fork') ? 'fork' : 'fresh', harness: kind, useWorktree: true };
  return { ...f, root, cwd, id, kind, starter, h, args, removals, handlers };
}

test('a cancelled native child can be restored and sent human input before or after cleanup on every native path', async (t) => {
  for (const mode of modes)
    for (const order of ['restore-first', 'cleanup-first'])
      await t.test(`${mode}/${order}`, async (t) => {
        const f = fixture(t, mode);
        const made = await makeChild(f.h.orch, 'parent', f.args);
        const restoreAndSend = async () => {
          assert.deepEqual(await worktreeRestore(f.cwd, f.root, f.root), { ok: true, restored: false });
          assert.equal(f.handlers.get('chats:patchMeta')!({ sender: {} }, made.chatId, { archived: null }), true);
          assert.equal(
            f.c.send(made.chatId, { id: 'human', text: 'Read this clean worktree', opts: { human: true } }, 1).action,
            'started',
          );
          await tick();
        };
        if (order === 'restore-first') {
          const archive = f.h.orch.o.archive;
          let restored: Promise<void>;
          f.h.orch.o.archive = (chat: string) => {
            const result = archive(chat);
            restored = restoreAndSend();
            return result;
          };
          await discardPrepared(f.h.orch, made);
          await restored!;
        } else {
          await discardPrepared(f.h.orch, made);
          await restoreAndSend();
        }
        assert.equal(f.s(made.chatId).turn, 'running');
        assert.equal(f.chats.get(made.chatId).meta.archived, null);
        assert.equal(fs.existsSync(f.cwd), true);
        assert.deepEqual(f.removals, []);
        assert.equal((await f.starter.discardWorktree(f.cwd)).discarded, false);
      });
});

test('native allocation owns its cwd before its first callback, including rejection and metadata failure', async (t) => {
  for (const mode of modes)
    for (const failure of ['native', 'metadata'])
      await t.test(`${mode}/${failure}`, async (t) => {
        let f: ReturnType<typeof fixture>;
        f = fixture(t, mode, () => {
          assert.equal(f.starter.preparedWorktrees.has(f.cwd), false, 'ownership must transfer before native publication');
          if (failure === 'native') throw new Error('native creation failed after publication');
        });
        if (failure === 'metadata') f.starter.o.chats = { patchMeta: () => false };
        await assert.rejects(makeChild(f.h.orch, 'parent', f.args), failure === 'native' ? /native creation failed/ : /save the new chat/);
        assert.equal(fs.existsSync(f.cwd), true);
        assert.deepEqual(f.removals, []);
        assert.equal((await f.starter.discardWorktree(f.cwd)).discarded, false);
      });
});

test('pending native forks and starts retain cwd through early cancellation and late success or rejection', async (t) => {
  for (const mode of ['codex', 'codex-fork', 'claude-fork'])
    for (const outcome of ['success', 'error'])
      await t.test(`${mode}/${outcome}`, async (t) => {
        const gate = deferred<void>();
        const f = fixture(t, mode, () => gate.promise);
        const pending = makeChild(f.h.orch, 'parent', f.args);
        await tick();
        assert.equal((await f.starter.discardWorktree(f.cwd)).discarded, false);
        if (outcome === 'error') gate.reject(new Error('native failed'));
        else gate.resolve();
        if (outcome === 'error') await assert.rejects(pending, /native failed/);
        else await discardPrepared(f.h.orch, await pending);
        assert.equal(fs.existsSync(f.cwd), true);
        assert.deepEqual(f.removals, []);
      });
});

test('settings and notes failures before native allocation still discard only their clean owned worktree', async (t) => {
  for (const failure of ['settings', 'notes'])
    await t.test(failure, async (t) => {
      const f = fixture(t, 'codex', () => assert.fail('native creation must not begin'));
      f.h.orch.o[failure === 'settings' ? 'childOptions' : 'prepareNotes'] = async () => {
        throw new Error('preparation failed');
      };
      await assert.rejects(makeChild(f.h.orch, 'parent', f.args), /preparation failed/);
      assert.equal(fs.existsSync(f.cwd), false);
      assert.equal(f.removals.length, 1);
      assert.deepEqual(f.removals[0], [['worktree', 'remove', f.cwd], f.root]);
    });
});

test('mixed-family forks retain the fresh native fallback before its cancelled child is restored', async (t) => {
  for (const target of ['codex', 'claude', 'acp:kimi'])
    for (const parent of ['codex', 'claude', 'acp:kimi']) {
      if (target === parent) continue;
      await t.test(`${parent}->${target}`, async (t) => {
        const f = fixture(t, target);
        f.chats.setSegments('parent', [{ harness: parent, nativeId: 'parent', start: 0, count: null }]);
        const made = await makeChild(f.h.orch, 'parent', { ...f.args, context: 'fork' });
        assert.equal(made.fallback, 'harness_differs');
        await discardPrepared(f.h.orch, made);
        assert.deepEqual(await worktreeRestore(f.cwd, f.root, f.root), { ok: true, restored: false });
        f.handlers.get('chats:patchMeta')!({ sender: {} }, made.chatId, { archived: null });
        assert.equal(f.c.send(made.chatId, { text: 'Continue here', opts: { human: true } }, 1).action, 'started');
        await tick();
        assert.equal(f.s(made.chatId).turn, 'running');
        assert.equal(fs.existsSync(f.cwd), true);
        assert.deepEqual(f.removals, []);
      });
    }
});

test('missing fork capabilities fail before native ownership and still remove the clean allocation', async (t) => {
  for (const mode of ['codex-fork', 'claude-fork'])
    await t.test(mode, async (t) => {
      const f = fixture(t, mode);
      delete f.starter.o[mode === 'codex-fork' ? 'codexFork' : 'claudeFork'];
      await assert.rejects(makeChild(f.h.orch, 'parent', f.args), /fork is not available/);
      assert.equal(fs.existsSync(f.cwd), false);
      assert.equal(f.removals.length, 1);
    });
});
