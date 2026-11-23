// Giving a chat another folder (electron/session/directoryGrant.cjs) on each harness: saved in the chat's configuration,
// taken at once by Claude's live process, applied from the next turn on Codex and ACP, and reported as it happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDirectoryGrant, LATER } = require('../electron/session/directoryGrant.cjs');

function setup(
  kind: string,
  over: { patch?: boolean; live?: boolean; control?: () => Promise<unknown>; noRecord?: boolean; config?: any } = {},
) {
  const records = new Map<string, any>();
  if (!over.noRecord) records.set('c', { meta: { config: over.config ?? { model: 'm' } } });
  const controlled: any[] = [];
  const live: any = {
    chats: {
      records,
      patchMeta: (id: string, patch: any) => {
        if (over.patch === false) return false;
        records.set(id, { meta: { ...records.get(id).meta, ...patch } });
        return true;
      },
    },
    controller: { ref: () => ({ kind, key: `${kind}:k` }) },
    claudeTurns: {
      api: {
        isLive: () => over.live !== false,
        control: async (...a: any[]) => (controlled.push(a), over.control?.()),
      },
    },
  };
  return { grant: createDirectoryGrant({ live }), records, controlled };
}

test('Claude: saved for later processes and added to the live one at once, with every folder granted so far', async () => {
  const t = setup('claude', { config: { additionalDirectories: ['/a'] } });
  assert.deepEqual(await t.grant('c', '/b'), { status: 'granted', note: null });
  assert.deepEqual(t.records.get('c').meta.config.additionalDirectories, ['/a', '/b']);
  assert.deepEqual(t.controlled, [['claude:k', 'addDirectories', ['/a', '/b']]]);
  // a folder already there is not saved again, and the process still gets it
  assert.deepEqual(await t.grant('c', '/b'), { status: 'granted', note: null });
  assert.deepEqual(t.records.get('c').meta.config.additionalDirectories, ['/a', '/b']);
});

test('Claude without a running process starts its next one with the saved folder; a process that refuses it is told apart', async () => {
  const idle = setup('claude', { live: false });
  assert.deepEqual(await idle.grant('c', '/b'), { status: 'granted', note: null });
  assert.deepEqual(idle.controlled, []);
  const broken = setup('claude', {
    control: async () => {
      throw new Error('process changed');
    },
  });
  const r = await broken.grant('c', '/b');
  assert.equal(r.status, 'saved');
  assert.match(r.note, /applies from the next turn/);
  assert.deepEqual(broken.records.get('c').meta.config.additionalDirectories, ['/b']);
});

test('Codex and ACP: saved, usable from the next turn, and told which', async () => {
  for (const kind of ['codex', 'acp:gemini']) {
    const t = setup(kind);
    const r = await t.grant('c', '/b');
    assert.equal(r.status, 'saved', kind);
    assert.equal(r.note, kind === 'codex' ? LATER.codex : LATER.acp, kind);
    assert.deepEqual(t.controlled, [], 'no process is touched');
    assert.deepEqual(t.records.get('c').meta.config, { model: 'm', additionalDirectories: ['/b'] });
  }
});

test('Claude with no turns service saved the folder for later', async () => {
  const t = setup('claude');
  const live: any = {
    chats: { records: new Map([['c', { meta: {} }]]), patchMeta: () => true },
    controller: { ref: () => ({ kind: 'claude', key: 'k' }) },
  };
  const r = await createDirectoryGrant({ live })('c', '/b');
  assert.deepEqual(r, { status: 'saved', note: LATER.claude });
  assert.equal(t.controlled.length, 0);
});

test('two grants at once keep both folders; a chat that is gone or cannot save is reported, not granted', async () => {
  const t = setup('codex');
  await Promise.all([t.grant('c', '/b'), t.grant('c', '/c')]);
  assert.deepEqual(t.records.get('c').meta.config.additionalDirectories, ['/b', '/c']);
  assert.deepEqual(await setup('claude', { noRecord: true }).grant('c', '/b'), { status: 'gone', note: null });
  assert.deepEqual(await setup('claude', { patch: false }).grant('c', '/b'), { status: 'unsaved', note: null });
  // a record with no configuration yet
  const bare = setup('codex');
  bare.records.set('c', { meta: {} });
  assert.equal((await bare.grant('c', '/b')).status, 'saved');
});
