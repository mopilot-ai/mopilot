// The @ menu's remote method: the schema's check, who may call it, the follow rule before and after the lists are read, and the lists the app builds from the sidebar and the chat's folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SchemaError, parseParams } from '../shared/remote/schema.mjs';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { PANEL } = require('../electron/remote/service.cjs');
const { createPanelAt, createPanelStartAt } = require('../electron/app/chromePanelAt.cjs');

test('mentions.list names a chat and what is typed, trimmed and bounded', () => {
  assert.deepEqual(parseParams('mentions.list', { chatId: 'c1' }), { chatId: 'c1', query: '' });
  assert.deepEqual(parseParams('mentions.list', { chatId: 'c1', query: '  src/a  ' }), { chatId: 'c1', query: 'src/a' });
  assert.equal((parseParams('mentions.list', { chatId: 'c1', query: 'x'.repeat(500) }) as any).query.length, 200);
  assert.equal((parseParams('mentions.list', { chatId: 'c1', query: 7 }) as any).query, '');
  assert.throws(
    () => parseParams('mentions.list', {}),
    (e: any) => e instanceof SchemaError && /isn't in MoPilot/.test(e.message),
  );
});

test('only a phone that follows the chat reads its mention lists; the panel and an unfollowing phone are refused', async () => {
  const lists = { chats: [{ id: 'c2', title: 'Two' }], files: [{ path: 'src/a.ts', name: 'a.ts', directory: false }] };
  const r = rig({ ops: { mentionsList: async () => lists } });
  const p = r.phone('p1');
  const refused = await p.ask('mentions.list', { chatId: 'c1', query: 'a' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'forbidden');
  assert.match(refused.error.message, /Follow this chat/);
  await p.ask('chat.follow', { chatId: 'c1' });
  const found = await p.ask('mentions.list', { chatId: 'c1', query: 'a' });
  assert.deepEqual(found.result, lists);
  assert.equal((await p.ask('mentions.list', { chatId: 'c2' })).error.code, 'forbidden', 'another chat is not followed');
  const panel = await r.service.call(PANEL, 'mentions.list', { chatId: 'c1' }).then(
    () => null,
    (e: any) => e,
  );
  assert.equal(panel.code, 'forbidden');
  assert.match(panel.message, /doesn't allow/);
});

test('a phone that stops following while the lists are read gets nothing', async () => {
  const r = rig();
  const p = r.phone('p1');
  await p.ask('chat.follow', { chatId: 'c1' });
  r.ops.mentionsList = async () => {
    await p.ask('chat.unfollow', { chatId: 'c1' });
    return { chats: [], files: [] };
  };
  const reply = await p.ask('mentions.list', { chatId: 'c1' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'forbidden');
});

test('the app lists a few recent chats for a bare @ and title matches while typing, never the chat itself, and the folder’s files', async () => {
  const chats = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, title: i === 4 ? null : `Trip ${i}` }));
  const asked: any[] = [];
  const at = createPanelAt({
    recent: async (limit: number, archived: boolean) => (asked.push(['recent', limit, archived]), chats),
    cwdOf: async (id: string) => (id === 'c0' ? '/work/shop' : null),
    search: async (cwd: string, query: string, o: any) => (
      asked.push(['search', cwd, query, o]),
      {
        files: [
          { path: 'src/a.ts', file_name: 'a.ts', match_type: 'file' },
          { path: 'src', file_name: 'src', match_type: 'directory' },
        ],
      }
    ),
  });
  const bare = await at({ chatId: 'c0', query: '' });
  assert.deepEqual(
    bare.chats.map((c: any) => c.id),
    ['c1', 'c2', 'c3'],
    'three recent chats, not this one, not one without a title',
  );
  assert.deepEqual(bare.files, [
    { path: 'src/a.ts', name: 'a.ts', directory: false },
    { path: 'src', name: 'src', directory: true },
  ]);
  assert.deepEqual(asked.slice(0, 2), [
    ['recent', 200, false],
    ['search', '/work/shop', '', { limit: 12 }],
  ]);
  const typing = await at({ chatId: 'c0', query: 'TRIP 1' });
  assert.deepEqual(
    typing.chats.map((c: any) => c.title),
    ['Trip 1', 'Trip 10', 'Trip 11'],
    'a match on the title, any case',
  );
  assert.equal((await at({ chatId: 'c0', query: 'trip' })).chats.length, 8, 'eight while typing');
  const none = await at({ chatId: 'c3', query: '' });
  assert.deepEqual(none.files, [], 'a chat without a folder has no files');
});

test('without a search of its own the app’s file search answers nothing for a folder that is not there', async () => {
  const at = createPanelAt({ recent: async () => [], cwdOf: async () => '/no/such/folder/for/mentions' });
  assert.deepEqual(await at({ chatId: 'c1', query: 'a' }), { chats: [], files: [] });
});

test('mentions.start names an agent, a saved project and what is typed, with the same bounds', () => {
  assert.deepEqual(parseParams('mentions.start', { harness: 'claude' }), { harness: 'claude', projectId: null, query: '' });
  assert.deepEqual(parseParams('mentions.start', { harness: 'codex', projectId: 'p1', query: ' a ' }), {
    harness: 'codex',
    projectId: 'p1',
    query: 'a',
  });
  assert.throws(
    () => parseParams('mentions.start', {}),
    (e: any) => e instanceof SchemaError,
  );
});

test('only a paired phone lists mentions for a chat about to start, and a phone removed while the lists are read gets nothing', async () => {
  const lists = { chats: [{ id: 'c2', title: 'Two' }], files: [] };
  const seen: any[] = [];
  const r = rig({ ops: { mentionsStart: async (p: any) => (seen.push(p), lists) } });
  const p = r.phone('p1');
  const found = await p.ask('mentions.start', { harness: 'claude', projectId: 'app', query: 'a' });
  assert.deepEqual(found.result, lists);
  assert.deepEqual(seen, [{ harness: 'claude', projectId: 'app', query: 'a' }]);
  const panel = await r.service.call(PANEL, 'mentions.start', { harness: 'claude' }).then(
    () => null,
    (e: any) => e,
  );
  assert.equal(panel.code, 'forbidden');
  const client = r.service.phones.get('p1').client;
  r.ops.mentionsStart = async () => {
    r.service.phones.delete('p1');
    return lists;
  };
  await assert.rejects(r.service.call(client, 'mentions.start', { harness: 'claude' }), /no longer paired/);
});

test('the start lists read the saved project’s files, none without a project, and no chat is left out as “this one”', async () => {
  const asked: any[] = [];
  const at = createPanelStartAt({
    recent: async () => [{ id: 'c1', title: 'One' }],
    projectCwd: (id: string | null) => (id === 'app' ? '/work/app' : null),
    search: async (cwd: string, query: string) => (
      asked.push([cwd, query]), { files: [{ path: 'a.ts', file_name: 'a.ts', match_type: 'file' }] }
    ),
  });
  assert.deepEqual(await at({ projectId: 'app', query: 'o' }), {
    chats: [{ id: 'c1', title: 'One' }],
    files: [{ path: 'a.ts', name: 'a.ts', directory: false }],
  });
  assert.deepEqual(asked, [['/work/app', 'o']]);
  assert.deepEqual((await at({ projectId: null, query: '' })).files, []);
  assert.deepEqual((await at({ query: '' })).files, [], 'no project key at all');
});

test('commands.list checks phone pairing before and after reading skills, while the panel still reads', async () => {
  const r = rig({ ops: { commands: async () => ({ commands: [] }) } });
  r.phone('p1');
  const client = r.service.phones.get('p1').client;
  assert.deepEqual(await r.service.call(PANEL, 'commands.list', { harness: 'codex' }), { commands: [] });
  r.ops.commands = async () => {
    r.service.phones.delete('p1');
    return { commands: [] };
  };
  await assert.rejects(r.service.call(client, 'commands.list', { harness: 'codex' }), /no longer paired/);
  let read = false;
  r.ops.commands = async () => ((read = true), { commands: [] });
  await assert.rejects(r.service.call(client, 'commands.list', { harness: 'codex' }), /no longer paired/);
  assert.equal(read, false);
});
