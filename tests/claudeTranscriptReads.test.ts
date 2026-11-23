// Reading Claude Code transcripts without blocking main (electron/harness/claude/transcripts.cjs): where a transcript was found
// is kept and checked again, checkpoints are kept until their file changes, a window's newer search replaces its
// older one, and a rewind reads its checkpoints again only for the process it began with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, home } from './support/electron-claude.ts';

const bin = fakeBin('reads/claude');
const projects = path.join(home, '.claude', 'projects');
const place = (dir: string, sid: string) => path.join(projects, dir, `${sid}.jsonl`);
const put = (dir: string, sid: string, rows: object[]) => {
  fs.mkdirSync(path.join(projects, dir), { recursive: true });
  fs.writeFileSync(place(dir, sid), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
const model = (m: string) => ({ type: 'assistant', message: { model: m } });

test('a transcript is looked for once and checked where it was; one that moved is found again', async () => {
  const t = load();
  put('m-proj', 'moving', [model('first')]);
  assert.equal(t.claude.transcriptPath('moving'), place('m-proj', 'moving'));
  // a copy that turns up in a folder listed earlier changes nothing while the known one is there
  put('a-proj', 'moving', [model('copy')]);
  assert.equal(t.claude.transcriptPath('moving'), place('m-proj', 'moving'));
  assert.deepEqual(await t.call('claude:sessionSettings', 'moving'), { model: 'first', effort: null });
  // moved (the known place is gone): both lookups find where it is now
  fs.rmSync(place('a-proj', 'moving'));
  fs.mkdirSync(path.join(projects, 'z-proj'), { recursive: true });
  fs.renameSync(place('m-proj', 'moving'), place('z-proj', 'moving'));
  assert.deepEqual(await t.call('claude:sessionSettings', 'moving'), { model: 'first', effort: null });
  fs.renameSync(place('z-proj', 'moving'), place('m-proj', 'moving'));
  assert.equal(t.claude.transcriptPath('moving'), place('m-proj', 'moving'));
  // gone everywhere: nothing, and a transcript written later is found
  fs.rmSync(place('m-proj', 'moving'));
  assert.equal(await t.call('claude:sessionSettings', 'moving'), null);
  assert.equal(t.claude.transcriptPath('moving'), null);
  put('m-proj', 'moving', [model('later')]);
  assert.deepEqual(await t.call('claude:sessionSettings', 'moving'), { model: 'later', effort: null });
});

test('the places kept are bounded: past the limit they are let go and found again', () => {
  const t = load();
  const many = path.join(projects, 'many');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i <= 2000; i++) fs.writeFileSync(path.join(many, `s${i}.jsonl`), '{}\n');
  for (let i = 0; i <= 2000; i++) assert.equal(t.claude.transcriptPath(`s${i}`), path.join(many, `s${i}.jsonl`));
  assert.equal(t.claude.transcriptPath('s0'), path.join(many, 's0.jsonl'));
  fs.rmSync(many, { recursive: true, force: true });
});

test('without a projects folder the asynchronous lookup finds nothing', async () => {
  const t = load();
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'no-such-config');
  try {
    assert.equal(await t.call('claude:sessionSettings', 'anything'), null);
    assert.deepEqual(await t.call('claude:checkpoints', 'anything'), {});
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('checkpoints are kept while their transcript is unchanged, read again once it changes, and bounded', async () => {
  const t = load();
  const rows = [
    { type: 'user', uuid: 'u1', parentUuid: null },
    { type: 'file-history-snapshot', messageId: 'u1' },
  ];
  put('cp', 'kept', rows);
  const first = await t.call('claude:checkpoints', 'kept');
  assert.deepEqual(first, { u1: null });
  assert.equal(await t.call('claude:checkpoints', 'kept'), first, 'an unchanged transcript is not read again');
  fs.appendFileSync(place('cp', 'kept'), JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1' }) + '\n');
  fs.appendFileSync(place('cp', 'kept'), JSON.stringify({ type: 'file-history-snapshot', messageId: 'u2' }) + '\n');
  const grown = await t.call('claude:checkpoints', 'kept');
  assert.deepEqual(grown, { u1: null, u2: 'a1' });
  // the least recently used go first: reading one again keeps it
  const kept: any[] = [];
  for (let i = 0; i < 23; i++) {
    put('cp', `other-${i}`, rows);
    kept.push(await t.call('claude:checkpoints', `other-${i}`));
  }
  assert.equal(await t.call('claude:checkpoints', 'kept'), grown);
  put('cp', 'other-last', rows);
  await t.call('claude:checkpoints', 'other-last');
  assert.equal(await t.call('claude:checkpoints', 'kept'), grown, 'the one used again is kept');
  const reread = await t.call('claude:checkpoints', 'other-0');
  assert.deepEqual(reread, { u1: null });
  assert.notEqual(reread, kept[0], 'the least recently used was let go and read again');
});

test("a search box's newer search replaces the scan still running for it; other boxes' go on", async () => {
  const t = load();
  const search = t.handlers.get('claude:search')!;
  put('find', 's-hit', [{ type: 'user', cwd: '/found', message: { content: 'the needle' } }]);
  const sessions = [...Array.from({ length: 20 }, (_, i) => ({ sessionId: `none-${i}` })), { sessionId: 's-hit' }];
  fakes.sdk.listSessions = async () => sessions.map((s) => ({ ...s }));
  const one = { sender: { id: 1 } };
  const replaced = search(one, 'needle', 30, 'palette');
  const otherBox = search(one, 'needle', 30, 'mentions');
  const otherWindow = search({ sender: { id: 2 } }, 'needle', 30, 'palette');
  const newer = search(one, 'needle', 30, 'palette');
  assert.deepEqual(await replaced, [], 'the replaced scan stops and finds nothing');
  assert.deepEqual(
    (await newer).map((s: any) => [s.sessionId, s.cwd]),
    [['s-hit', '/found']],
  );
  for (const other of [otherBox, otherWindow])
    assert.deepEqual(
      (await other).map((s: any) => s.sessionId),
      ['s-hit'],
    );
  // once done, the box's next search runs on its own
  assert.deepEqual(
    (await search(one, 'needle', 30, 'palette')).map((s: any) => s.sessionId),
    ['s-hit'],
  );
});

test('a search lists the transcripts once: the first copy in listing order, files that are not transcripts skipped', async () => {
  const t = load();
  put('a-first', 'dup', [{ type: 'user', message: { content: 'needle in the first copy' } }]);
  put('b-second', 'dup', [{ type: 'user', message: { content: 'nothing here' } }]);
  put('b-second', 'only-second', [{ type: 'user', message: { content: 'nothing' } }]);
  fs.writeFileSync(path.join(projects, 'b-second', 'notes.txt'), 'needle');
  fs.writeFileSync(path.join(projects, 'loose-file.jsonl'), 'needle');
  fakes.sdk.listSessions = async () => [
    { sessionId: 'only-second' },
    { sessionId: 'dup' },
    { sessionId: 'notes.txt' },
    { sessionId: 'absent' },
  ];
  assert.deepEqual(
    (await t.call('claude:search', 'needle')).map((s: any) => s.sessionId),
    ['dup'],
  );
  fs.rmSync(path.join(projects, 'loose-file.jsonl'));
  // no projects folder: nothing to read
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'no-such-config');
  try {
    assert.deepEqual(await t.call('claude:search', 'needle'), []);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('a turn that starts while a rewind reads its checkpoints stops the rewind', async () => {
  const t = load();
  const sid = '45454545-4545-4545-8545-454545454545';
  const key = `claude:${sid}`;
  put('rw', sid, [
    { type: 'user', uuid: 'm1', parentUuid: null },
    { type: 'file-history-snapshot', messageId: 'm1' },
    { type: 'user', uuid: 'm2', parentUuid: 'a1' },
    { type: 'file-history-snapshot', messageId: 'm2' },
  ]);
  let rewound = 0;
  fakes.onQuery = (q: any) => {
    q.reply = null;
    q.rewindFiles = async () => (rewound++, { canRewind: true, filesChanged: [] });
  };
  // a live, idle process for the chat
  assert.equal((await t.call('claude:rewind', key, { bin, sessionId: sid }, 'm2', true)).canRewind, true);
  const rewinding = t.call('claude:rewind', key, { bin, sessionId: sid }, 'm2', false);
  const sent = t.claude.send(key, { bin, sessionId: sid }, { role: 'user', content: 'meanwhile' });
  await assert.rejects(rewinding, /Wait for this turn to finish/);
  await sent;
  assert.equal(rewound, 1, 'only the dry run reached the process');
  await t.call('claude:control', key, 'close');
});

test("the list reads a session's folder without blocking main, as the harness's own lookup reads it", async () => {
  const t = load();
  put('cwd', 'near', [{ type: 'user', cwd: '/near', message: {} }]);
  put('cwd', 'far', [{ type: 'user', message: { content: 'x'.repeat(300 * 1024) } }, { cwd: '/far' }]);
  put('cwd', 'none', [{ type: 'user' }]);
  put('cwd', 'locked', [{ cwd: '/locked' }]);
  fs.chmodSync(place('cwd', 'locked'), 0);
  fs.mkdirSync(place('cwd', 'folder'), { recursive: true });
  const ids = ['absent', 'near', 'far', 'none', 'locked', 'folder'];
  fakes.sdk.listSessions = async () => [...ids.map((sessionId) => ({ sessionId })), { sessionId: 'given', cwd: '/given' }];
  const list = await t.call('claude:list');
  assert.deepEqual(
    list.map((s: any) => s.cwd),
    [undefined, '/near', '/far', undefined, undefined, undefined, '/given'],
  );
  assert.deepEqual(
    await Promise.all(ids.map((id) => t.claude.turnApi.sessionCwd(id))),
    list.slice(0, -1).map((s: any) => s.cwd),
  );
  fs.chmodSync(place('cwd', 'locked'), 0o644);
  // every session has its folder: no transcript is looked for
  fakes.sdk.listSessions = async () => [{ sessionId: 'near', cwd: '/given' }];
  assert.deepEqual(
    (await t.call('claude:list')).map((s: any) => s.cwd),
    ['/given'],
  );
});

test('the asynchronous lookup main uses for transcript events finds a transcript, or none', async () => {
  const t = load();
  put('f-proj', 'found-async', [model('x')]);
  assert.equal(await t.claude.turnApi.findTranscript('found-async'), place('f-proj', 'found-async'));
  assert.equal(await t.claude.turnApi.findTranscript('nowhere-async'), null);
});
