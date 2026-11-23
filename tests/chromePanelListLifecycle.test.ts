// Panel/phone chat-list caching is lazy and invalidated by chat mutations, including reads still pending at mutation time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { PANEL } = require('../electron/remote/service.cjs');
const { createPhoneSources } = require('../electron/app/phoneListSources.cjs');
const { createRecentList } = require('../electron/app/chromePanelRecent.cjs');

function fixture(t: any, read: () => Promise<any[]>) {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  return createChromePanel({
    live: { chats: h.chats, controller: h.c },
    claude: {},
    sources: { codex: read },
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open: () => {},
  });
}

test('constructing panel services never starts a harness or consumes its pagination', async (t) => {
  let reads = 0;
  const panel = fixture(t, async () => {
    reads++;
    return [];
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 0, 'no device asked for a list');
  await panel.service.call(PANEL, 'chats.recent', {});
  assert.equal(reads, 1, 'the first actual request owns discovery');
});

test('a chat mutation expires the fresh native list before the next read, without expiring a just-completed refresh', async (t) => {
  let rows: any[] = [];
  let reads = 0;
  const panel = fixture(t, async () => {
    reads++;
    return rows;
  });
  const recent = () => panel.service.call(PANEL, 'chats.recent', {});
  assert.deepEqual((await recent()).chats, []);
  rows = [{ key: 'new-chat', title: 'New chat', at: 1 }];
  panel.service.onChatsChanged();
  assert.deepEqual(
    (await recent()).chats.map((c: any) => c.id),
    ['new-chat'],
  );
  const before = reads;
  await recent();
  assert.equal(reads, before, 'the completion notification does not invalidate its own result');
});

for (const failure of [false, true]) {
  test(`an invalidated pending source cannot publish its obsolete ${failure ? 'failure' : 'success'}`, async () => {
    let generation = 0;
    const pending: { ok(rows: any[]): void; fail(error: Error): void }[] = [];
    let changes = 0;
    const source = createPhoneSources(
      { codex: () => new Promise((resolve, reject) => pending.push({ ok: resolve, fail: reject })) },
      {
        generation: () => generation,
        changed: () => {
          changes++;
        },
        coldMs: 1000,
      },
    );
    const old = source.codex(false).catch(() => undefined);
    await waitFor(() => pending.length === 1, 'old source started');
    generation++;
    const current = source.codex(false);
    await waitFor(() => pending.length === 2, 'new source bypasses retired pending read');
    const rows = [{ key: 'new', title: 'New', at: 2 }];
    pending[1].ok(rows);
    assert.deepEqual(await current, rows);
    if (failure) pending[0].fail(new Error('obsolete'));
    else pending[0].ok([{ key: 'old', title: 'Old', at: 1 }]);
    await old;
    assert.deepEqual(await source.codex(false), rows);
    assert.equal(changes, 1);
  });
}

for (const failure of [false, true]) {
  test(`mutation retires a pending ${failure ? 'rejection' : 'success'} before any replacement read starts`, async () => {
    let generation = 0;
    let reads = 0;
    let changes = 0;
    let settle: () => void = () => undefined;
    const rows = [{ key: 'new', title: 'New', at: 2 }];
    const source = createPhoneSources(
      {
        codex: async () => {
          if (reads++) return rows;
          return new Promise((resolve, reject) => {
            settle = () => (failure ? reject(new Error('obsolete')) : resolve([{ key: 'old', title: 'Old', at: 1 }]));
          });
        },
      },
      {
        generation: () => generation,
        changed: () => {
          changes++;
        },
      },
    );
    const old = source.codex(false).catch(() => undefined);
    await waitFor(() => reads === 1, 'old source');
    generation++;
    settle();
    await old;
    assert.equal(changes, 0, 'obsolete producer publishes no change');
    assert.deepEqual(await source.codex(false), rows);
    assert.equal(changes, 1);
  });
}

test('a failed refresh after a mutation never makes the retained result fresh in the new generation', async () => {
  let generation = 0;
  let reads = 0;
  const rows = [{ key: 'new', title: 'New', at: 2 }];
  const source = createPhoneSources(
    {
      codex: async () => {
        reads++;
        if (reads === 1) return [];
        if (reads === 2) throw new Error('transient');
        return rows;
      },
    },
    { generation: () => generation, now: () => 1000 },
  );
  assert.deepEqual(await source.codex(false), []);
  generation++;
  assert.deepEqual(await source.codex(false), [], 'failed refresh retains the previous list');
  assert.deepEqual(await source.codex(false), rows, 'next request retries without waiting fifteen seconds');
  assert.equal(reads, 3);
});

test('concurrent reads join an invalidated warm refresh instead of mistaking its old result for current data', async () => {
  let generation = 0;
  let reads = 0;
  let resolve: (rows: any[]) => void = () => undefined;
  const source = createPhoneSources(
    {
      codex: async () => {
        if (++reads === 1) return [];
        return new Promise<any[]>((done) => {
          resolve = done;
        });
      },
    },
    { generation: () => generation, now: () => 1000, warmMs: 5000 },
  );
  await source.codex(false);
  generation++;
  const first = source.codex(false);
  await waitFor(() => reads === 2, 'warm replacement');
  let done = false;
  const second = source.codex(false).then((rows: any[]) => {
    done = true;
    return rows;
  });
  await new Promise<void>((next) => setImmediate(next));
  assert.equal(done, false, 'the concurrent caller joins the bounded replacement read');
  const rows = [{ key: 'new', title: 'New', at: 2 }];
  resolve(rows);
  assert.deepEqual(await first, rows);
  assert.deepEqual(await second, rows);
  assert.equal(reads, 2);
});

test('the extracted recent-list entrypoint hides current and previous MoMo chats from every harness', async () => {
  const records = new Map<string, any>([
    ['visible', { segments: [], meta: {} }],
    ['hidden-codex', { segments: [], meta: { momo: 'main', pinned: true } }],
    ['hidden-claude', { segments: [], meta: { momo: 'previous', archived: 1 } }],
    ['hidden-acp', { segments: [], meta: { momo: 'main' } }],
  ]);
  const row = (key: string) => ({ key, title: key, at: 1 });
  const recent = createRecentList({
    sources: {
      codex: async () => [row('visible'), row('hidden-codex')],
      claude: async () => [row('hidden-claude')],
      acp: async () => [row('hidden-acp')],
    },
    live: { chats: { records } },
    home: '/home/test',
    projects: () => [],
    prefs: () => ({}),
    changed: () => undefined,
  });
  assert.deepEqual(
    (await recent.read(200, false)).map((chat: any) => chat.id),
    ['visible'],
  );
  assert.deepEqual(await recent.read(200, true), []);
});
