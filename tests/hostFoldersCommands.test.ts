// `commands` of the app's folder service (electron/host/folders.cjs, #4915): asks the machine what an agent offers for a folder, reads the answer defensively, and tells an older Host from a refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { helloParams } from '../shared/host/schema.mjs';
const require = createRequire(import.meta.url);
const { createHostFolders } = require('../electron/host/folders.cjs');
/** What a Host answers a hello with when it speaks everything this app does. */
const HELLO = helloParams();
const { OwnershipStore } = require('../electron/host/ownership.cjs');

/** A service over a fake connection: `answer` is the Host's reply per method. */
function world(o: { answer?: Record<string, any> } = {}) {
  const calls: any[] = [];
  const opened: { closed: number }[] = [];
  const store = new OwnershipStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-folders-')), 'host-ownership.json'));
  const folders = createHostFolders({
    open: async (hostId: string) => {
      const rec = { closed: 0 };
      opened.push(rec);
      return {
        call: async (method: string, params: any, opts: any) => {
          calls.push({ hostId, method, params, opts });
          const reply = o.answer?.[method];
          if (reply instanceof Error) throw reply;
          return reply;
        },
        close: () => void rec.closed++,
      };
    },
    store,
  });
  return { folders, calls, opened };
}

test('commands asks the machine what an agent offers for a folder, reads the answer defensively, and tells an older Host from a refusal (#4915)', async () => {
  const answer = {
    listed: true,
    commands: [
      { name: 'compact', description: 'Summarize', hint: '[focus]' },
      { name: 'review', kind: 'skill', insert: '$review' },
      { name: 'bad name' },
    ],
  };
  const w = world({ answer: { 'host.hello': HELLO, 'host.commands': answer } });
  assert.deepEqual(await w.folders.commands('box', { harness: 'claude', cwd: '/srv/app' }), {
    listed: true,
    commands: [
      { name: 'compact', description: 'Summarize', hint: '[focus]', kind: 'command', insert: '/compact ' },
      { name: 'review', description: '', kind: 'skill', insert: '$review ' },
    ],
  });
  assert.equal(w.calls[0].method, 'host.hello', 'a protocol method: hello first');
  assert.deepEqual(w.calls[1], {
    hostId: 'box',
    method: 'host.commands',
    params: { harness: 'claude', cwd: '/srv/app' },
    opts: { timeoutMs: 45_000 },
  });
  assert.equal(w.opened[0].closed, 1);
  // no folder: the machine's own agent list, as for a chat not started yet
  await w.folders.commands('box', { harness: 'acp:kimi' });
  assert.deepEqual(w.calls.at(-1).params, { harness: 'acp:kimi' });
  assert.deepEqual(
    await world({ answer: { 'host.hello': HELLO, 'host.commands': { listed: false, commands: [] } } }).folders.commands('box', {
      harness: 'codex',
    }),
    { listed: false, commands: [] },
  );
  // an answer that is not a list is refused, not drawn
  for (const reply of [null, 'x', { listed: 'yes', commands: [] }, { listed: true, commands: 'none' }])
    await assert.rejects(
      world({ answer: { 'host.hello': HELLO, 'host.commands': reply } }).folders.commands('box', { harness: 'claude' }),
      /cannot read/,
    );
  // a Host from before the method, or one with no source for it, is one to update; any other refusal passes with its code
  for (const error of [
    new Error('Unknown method host.commands.'),
    Object.assign(new Error('Update the host.'), { code: 'feature_missing' }),
  ])
    assert.deepEqual(
      await world({ answer: { 'host.hello': HELLO, 'host.commands': error } }).folders.commands('box', { harness: 'claude' }),
      {
        listed: false,
        commands: [],
        outdated: true,
      },
    );
  const refusal = Object.assign(new Error('Not allowed.'), { code: 'forbidden' });
  await assert.rejects(
    world({ answer: { 'host.hello': HELLO, 'host.commands': refusal } }).folders.commands('box', { harness: 'claude' }),
    (e: any) => e.code === 'forbidden',
  );
  // a request that names no agent, or a folder that is not a full path, is refused before any connection is made
  const none = world();
  await assert.rejects(none.folders.commands('box', {} as any));
  await assert.rejects(none.folders.commands('box', { harness: 'claude', cwd: 'proj' }));
  assert.equal(none.opened.length, 0);
});
