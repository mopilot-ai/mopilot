// The app's folder service for a machine's writes (electron/host/folders.cjs commit and discard, #5050): requests validated before a connection is made, answers read defensively, and an older Host told to update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHostFolders } = require('../electron/host/folders.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-folders-write-')), 'host-ownership.json');

/** A service over a fake connection: `answer` is the Host's reply per method. */
function world(o: { answer?: Record<string, any>; features?: string[] } = {}) {
  const calls: any[] = [];
  const hellos: string[] = [];
  const opened: { closed: number }[] = [];
  const folders = createHostFolders({
    open: async (hostId: string) => {
      const rec = { closed: 0 };
      opened.push(rec);
      // a Host answers its `host.` methods only on a connection that said hello (host/src/protocol.mjs)
      let greeted = false;
      return {
        call: async (method: string, params: any, opts: any) => {
          if (method === 'host.hello') {
            hellos.push(hostId);
            const hello = o.answer?.['host.hello'] ?? {
              protocol: { minor: 1, floor: 1 },
              features: o.features ?? ['gitWrite', 'gitBranch'],
              capabilities: {},
            };
            if (hello instanceof Error) throw hello;
            greeted = true;
            return hello;
          }
          if (method.startsWith('host.') && !greeted) throw new Error('Say hello first.');
          calls.push({ hostId, method, params, opts });
          const reply = o.answer?.[method];
          if (reply instanceof Error) throw reply;
          return reply;
        },
        close: () => void rec.closed++,
      };
    },
    store: new OwnershipStore(tmpFile()),
  });
  return { folders, calls, hellos, opened };
}

test('commit and discard ask the machine to change its folder with a long bound, read the answer defensively, and say to update an older Host', async () => {
  const done = { ok: true, stderr: '' };
  const w = world({
    answer: {
      'host.gitCommit': { ...done, warning: 'Committed, but…', extra: 1 },
      'host.gitDiscard': { ok: false, stderr: 'no', refused: true },
    },
  });
  assert.deepEqual(await w.folders.commit('box', { path: '/srv/app', message: 'm', files: null }), { ...done, warning: 'Committed, but…' });
  assert.deepEqual(w.calls[0], {
    hostId: 'box',
    method: 'host.gitCommit',
    params: { path: '/srv/app', message: 'm', files: null },
    opts: { timeoutMs: 360_000 },
  });
  assert.deepEqual(await w.folders.discard('box', { path: '/srv/app', file: 'a.ts' }), { ok: false, stderr: 'no', refused: true });
  assert.deepEqual(w.calls[1].params, { path: '/srv/app', file: 'a.ts' });
  for (const reply of [null, { ok: 'yes', stderr: '' }, { ok: true }, { ok: true, stderr: 'x'.repeat(4001) }])
    await assert.rejects(
      world({ answer: { 'host.gitCommit': reply, 'host.gitDiscard': reply } }).folders.commit('box', {
        path: '/srv',
        message: 'm',
        files: null,
      }),
      /cannot read/,
    );
  await assert.rejects(world({ answer: { 'host.gitDiscard': null } }).folders.discard('box', { path: '/srv', file: null }), /cannot read/);
  // a Host from before the writes answers an unknown method, an unknown request or a missing feature: the app says to update it; a refusal keeps its code
  for (const old of [
    new Error('Unknown method host.gitCommit.'),
    new Error('Unknown request: host.gitCommit'),
    Object.assign(new Error('The host cannot do this safely yet.'), { code: 'feature_missing' }),
  ])
    await assert.rejects(
      world({ answer: { 'host.gitCommit': old } }).folders.commit('box', { path: '/srv', message: 'm', files: null }),
      (e: any) => e.code === 'host_outdated' && /commit or discard/.test(e.message),
    );
  // the hello itself: a Host too old to know it, or one that agreed on no write, is told to update too
  for (const w of [world({ answer: { 'host.hello': new Error('Unknown method host.hello.') } }), world({ features: [] })])
    await assert.rejects(
      w.folders.discard('box', { path: '/srv', file: null }),
      (e: any) => e.code === 'host_outdated' && /commit or discard/.test(e.message),
    );
  const refusal = Object.assign(new Error('This folder is not a git repository.'), { code: 'not_a_repository' });
  await assert.rejects(
    world({ answer: { 'host.gitDiscard': refusal } }).folders.discard('box', { path: '/srv', file: null }),
    (e: any) => e.code === 'not_a_repository',
  );
  // a request that names no folder or a file outside it is refused before any connection is made
  const none = world();
  await assert.rejects(none.folders.commit('box', { path: '/srv', message: '', files: null }));
  await assert.rejects(none.folders.discard('box', { path: '/srv', file: '../x' }));
  assert.equal(none.opened.length, 0);
});

test('turnDiff asks the machine what one turn changed, reads the answer defensively, and says to update a Host from before it (#5255)', async () => {
  const features = ['gitTurnDiff'];
  const good = { isRepo: true, baseline: true, patch: 'diff --git a/x b/x\n+1\n', truncated: true, extra: 1 };
  const w = world({ features, answer: { 'host.gitTurnDiff': good } });
  assert.deepEqual(await w.folders.turnDiff('box', { path: '/srv/app', turnId: 't1' }), {
    isRepo: true,
    baseline: true,
    patch: good.patch,
    truncated: true,
  });
  assert.equal(w.calls[0].method, 'host.gitTurnDiff');
  assert.deepEqual(w.calls[0].params, { path: '/srv/app', turnId: 't1' });
  const says = (reply: unknown) =>
    world({ features, answer: { 'host.gitTurnDiff': reply } }).folders.turnDiff('box', { path: '/srv', turnId: 't' });
  assert.deepEqual(await says({ isRepo: false }), { isRepo: false });
  assert.deepEqual(await says({ isRepo: true, baseline: false, patch: 'ignored' }), { isRepo: true, baseline: false });
  assert.deepEqual(await says({ isRepo: true, baseline: true, patch: '' }), { isRepo: true, baseline: true, patch: '', truncated: false });
  // the big new files the Host left out: how many and the first few, or nothing from a reply that says it otherwise
  const left = (skipped: unknown) => says({ isRepo: true, baseline: true, patch: '', skipped }).then((r: any) => r.skipped);
  assert.deepEqual(await left({ count: 2, paths: ['a', 'b'], extra: 1 }), { count: 2, paths: ['a', 'b'] });
  for (const bad of [
    undefined,
    null,
    'x',
    { count: 0, paths: [] },
    { count: 1.5, paths: [] },
    { count: 1, paths: [''] },
    { count: 1, paths: Array(11).fill('p') },
    { count: 2_000_000, paths: [] },
  ])
    assert.equal(await left(bad), undefined);
  for (const reply of [
    null,
    { isRepo: 'yes' },
    { isRepo: true },
    { isRepo: true, baseline: 'maybe' },
    { isRepo: true, baseline: true, patch: 7 },
    { isRepo: true, baseline: true, patch: 'x'.repeat(4_100_001) },
  ])
    await assert.rejects(says(reply), /cannot read/);
  // a Host from before the method, or one that agreed on no such feature, is told to update, in the words of what the person was doing
  const outdated = (e: any) => e.code === 'host_outdated' && e.message === "Update the Host on that machine to see a turn's changes.";
  await assert.rejects(
    world({ features, answer: { 'host.gitTurnDiff': new Error('Unknown method host.gitTurnDiff.') } }).folders.turnDiff('box', {
      path: '/srv',
      turnId: 't',
    }),
    outdated,
  );
  await assert.rejects(world({ features: [] }).folders.turnDiff('box', { path: '/srv', turnId: 't' }), outdated);
  // a request that names no turn is refused before any connection is made
  const none = world({ features });
  await assert.rejects(none.folders.turnDiff('box', { path: '/srv', turnId: '' }));
  assert.equal(none.opened.length, 0);
});

test('a refusal of the Host that comes with words and a code reaches the app unchanged, so the pane can say it (#5255)', async () => {
  const words = 'Git on this machine could not read its configuration. Check its ~/.gitconfig and the repository’s .git/config.';
  const refusal = Object.assign(new Error(words), { code: 'unavailable' });
  await assert.rejects(
    world({ answer: { 'git.diff': refusal } }).folders.diff('box', { path: '/srv', scope: 'uncommitted' }),
    (e: any) => e.code === 'unavailable' && e.message === words,
  );
});
