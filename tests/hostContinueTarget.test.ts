// The Host as the target of a continue (host/src/continueTarget.mjs): the folder and agent are checked, the handoff waits until the chat is bound, and the first message takes it once (B1, B3, W3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createContinueTarget } from '../host/src/continueTarget.mjs';

const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-target-'));
  const target = createContinueTarget({
    dir,
    hostFs: {
      existingDirectory: async (p: any) => {
        if (p === '/missing') throw Object.assign(new Error('gone'), { code: 'not_found' });
        return `${p}/real`;
      },
    },
    harnesses: () => ['gemini'],
  });
  return { dir, target };
};

test('check accepts an agent this Host starts and a folder that is there, and refuses the rest with a code', async () => {
  const { target } = make();
  assert.equal(await target.check({ harness: 'acp:gemini', cwd: '/w' }), '/w/real');
  for (const harness of ['codex', 'claude', 'acp:other', 'nonsense'])
    await assert.rejects(
      target.check({ harness, cwd: '/w' }),
      (e: any) => e.code === 'harness_not_configured' && e.message.includes(harness),
    );
  await assert.rejects(target.check({ harness: 'acp:gemini', cwd: '/missing' }), (e: any) => e.code === 'not_found');
});

test('the handoff is kept, bound to the chat when it becomes the owner, taken for the first message and gone after done', async () => {
  const { dir, target } = make();
  const { nativeId } = await target.open({ chatId: 'claude:c1', harness: 'acp:gemini', cwd: '/w/real', handoff: 'history' });
  assert.equal(target.take('claude:c1'), null, 'not the owner yet');
  target.serve({ chatId: 'claude:c1', nativeId });
  assert.deepEqual(target.take('claude:c1'), { text: 'history', cwd: '/w/real', harness: 'acp:gemini', chatId: 'claude:c1', id: nativeId });
  assert.deepEqual(
    target.take('claude:c1'),
    { text: 'history', cwd: '/w/real', harness: 'acp:gemini', chatId: 'claude:c1', id: nativeId },
    'read again until done',
  );
  target.done('claude:c1');
  assert.equal(target.take('claude:c1'), null);
  target.done('claude:c1');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'stash')), []);
});

test('a handoff nobody uses is dropped; ids that are not ours and handoffs that are gone touch nothing', async () => {
  const { dir, target } = make();
  const { nativeId } = await target.open({ chatId: 'c', harness: 'acp:gemini', cwd: '/w', handoff: 'x' });
  await target.discard(nativeId);
  await target.discard(nativeId);
  await target.discard('../../etc/passwd');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'stash')), []);
  target.serve({ chatId: 'c', nativeId });
  target.serve({ chatId: 'c', nativeId: '../escape' });
  assert.equal(target.take('c'), null);
});

test('W3/B1: a handoff file that is unreadable or of the wrong shape is no handoff, and a missing folder is optional', async () => {
  const { dir, target } = make();
  const { nativeId } = await target.open({ chatId: 'c', harness: 'acp:gemini', cwd: '/w', handoff: 'x' });
  target.serve({ chatId: 'c', nativeId });
  const bound = path.join(dir, 'bound', fs.readdirSync(path.join(dir, 'bound'))[0]);
  fs.writeFileSync(bound, '{ truncated');
  assert.equal(target.take('c'), null);
  fs.writeFileSync(bound, JSON.stringify({ handoff: 5 }));
  assert.equal(target.take('c'), null);
  fs.writeFileSync(bound, JSON.stringify({ handoff: 'only text', cwd: 7 }));
  assert.deepEqual(target.take('c'), { text: 'only text', cwd: undefined, harness: undefined, chatId: undefined, id: undefined });
});

test('pending lists the chats whose handoff still waits, also after a restart; with nothing bound it is empty; accepts replaces the agent list', async () => {
  const { dir, target } = make();
  assert.deepEqual(target.pending(), []);
  for (const id of ['c1', 'c2']) {
    const { nativeId } = await target.open({ chatId: id, harness: 'claude', cwd: '/w', handoff: `for ${id}` });
    target.serve({ chatId: id, nativeId });
  }
  target.serve({ chatId: 'c3', nativeId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  fs.writeFileSync(path.join(dir, 'bound', 'not-a-handoff.json'), '{ broken');
  assert.deepEqual(
    target
      .pending()
      .map((p: any) => p.chatId)
      .sort(),
    ['c1', 'c2'],
  );
  target.done('c1');
  assert.deepEqual(
    target.pending().map((p: any) => p.chatId),
    ['c2'],
  );
  // with neither an agent list nor a test, nothing is accepted
  const none = createContinueTarget({ dir, hostFs: { existingDirectory: async (p: any) => p } });
  await assert.rejects(none.check({ harness: 'acp:gemini', cwd: '/x' }), (e: any) => e.code === 'harness_not_configured');
  const anything = createContinueTarget({
    dir,
    hostFs: { existingDirectory: async (p: any) => p },
    accepts: (h: string) => h === 'claude',
  });
  assert.equal(await anything.check({ harness: 'claude', cwd: '/x' }), '/x');
  await assert.rejects(anything.check({ harness: 'acp:gemini', cwd: '/x' }), (e: any) => e.code === 'harness_not_configured');
});
