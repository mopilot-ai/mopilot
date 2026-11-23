// The dev host's fake app: seeded chats, and the scripted turn a new chat runs (stream, command that waits for approval, result) with allow, deny, Stop at each point, queued follow-ups and a failing command.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { until } from './support/mobileStack.ts';
import { rig as remoteRig } from './support/remote-kit.ts';
import { createFakeApp, GONE, HARNESSES } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { ensureRepo } from '../scripts/mobile-dev-host/repo.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-fake-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** An app whose service records what phones would be sent; `sleepHook` runs at each streamed word. */
function rig(
  o: {
    sleepHook?: (n: number) => void;
    status?: (cwd: string) => Promise<string>;
    now?: () => number;
    onLog?: (line: string) => void;
  } = {},
) {
  let sleeps = 0;
  const logs: string[] = [];
  const app = createFakeApp({
    repo: '/repo',
    log: (l: string) => (logs.push(l), o.onLog?.(l)),
    now: o.now ?? (() => 5_000_000),
    sleep: async () => void o.sleepHook?.(++sleeps),
    status: o.status ?? (async () => ' M src/price.ts\n?? notes/todo.md\n'),
  });
  const events: any[] = [];
  const patches: any[] = [];
  app.bind({ attached: true, onFeedEvent: (e: any) => events.push(e), onSessionPatch: (p: any) => patches.push(p) });
  const cardOf = async (id: string) => (await app.ops.cardsOf(id))[0];
  const start = async (text = 'check the repo', extra: object = {}) =>
    (await app.ops.start({ harness: 'codex', text, projectId: null, ...extra })).chatId as string;
  return { app, ops: app.ops, events, patches, logs, cardOf, start };
}

test('eight chats are seeded: a finished one, a quiet one, one holding every message MoPilot wrote itself, one waiting for approval, three linked sessions and the oldest, a chat of pictures', async () => {
  const { ops, cardOf } = rig();
  const recent = await ops.recent(10);
  const ids = recent.map((c: any) => c.id);
  assert.equal(ids[1], 'dev-seed-authored');
  assert.equal(ids.at(-1), 'dev-seed-pictures');
  assert.deepEqual(
    ids.filter((id: string) => id !== 'dev-seed-authored' && id !== 'dev-seed-pictures'),
    ['dev-seed-waiting', 'dev-seed-linked-ask', 'dev-seed-login', 'dev-seed-readme', 'dev-seed-linked-notes', 'dev-seed-linked-check'],
  );
  assert.deepEqual(
    (await ops.recent(1)).map((c: any) => c.id),
    ['dev-seed-waiting'],
  );
  // the Claude Code chat runs in a project and on a login the Mac names, as a Mac with several accounts says it
  const byId = (id: string) => recent.find((c: any) => c.id === id) as any;
  assert.deepEqual(
    [byId('dev-seed-readme').project, byId('dev-seed-readme').projectId, byId('dev-seed-readme').account],
    ['dev-repo', 'dev-repo', 'work@mopilot.example'],
  );
  assert.equal(byId('dev-seed-login').account, undefined, 'the others name no login');
  // the README chat started two linked sessions, one finished and one failed; the others name no parent
  assert.deepEqual(
    recent.filter((c: any) => c.parentId).map((c: any) => [c.id, c.parentId, c.ended]),
    [
      ['dev-seed-linked-ask', 'dev-seed-readme', undefined],
      ['dev-seed-linked-notes', 'dev-seed-readme', 'finished'],
      ['dev-seed-linked-check', 'dev-seed-readme', 'failed'],
    ],
  );
  assert.equal('parentId' in byId('dev-seed-readme'), false);
  assert.equal(ops.turn('dev-seed-waiting'), 'awaitingUser');
  assert.equal(ops.turn('dev-seed-login'), 'idle');
  assert.equal(ops.turn('nope'), undefined);
  assert.equal((await cardOf('dev-seed-waiting')).detail, 'rm -rf dist coverage');
  assert.deepEqual(await ops.cardsOf('dev-seed-login'), []);
  const items = await ops.items('dev-seed-login', 2);
  assert.equal(items.items.length, 2);
  assert.equal(items.items.at(-1).role, 'assistant');
  assert.deepEqual((await ops.items('nope', 5)).items, []);
  await assert.rejects(ops.read('nope'), new RegExp(GONE));
  await assert.rejects(ops.send({ chatId: 'nope', text: 'hi' }), new RegExp(GONE));
  assert.equal(ops.reachable('dev-seed-login'), true);
  assert.equal(ops.reachable('nope'), false);
});

test('recent pages by offset: the same newest-first order, a start past the end is empty', async () => {
  const { ops } = rig();
  const all = (await ops.recent(10)).map((c: any) => c.id);
  assert.deepEqual(
    (await ops.recent(2, false, 1)).map((c: any) => c.id),
    all.slice(1, 3),
  );
  assert.deepEqual(
    (await ops.recent(2, false, all.length)).map((c: any) => c.id),
    [],
  );
});

test('a phone renames, archives and restores a chat: the archive is its own list; an unknown chat is refused', async () => {
  const { ops, logs } = rig();
  const [first] = (await ops.recent(10)).map((c: any) => c.id);
  await ops.renameChat(first, 'Renamed');
  assert.equal((await ops.recent(10)).find((c: any) => c.id === first).title, 'Renamed');
  await ops.archiveChat(first, true);
  assert.ok(!(await ops.recent(10)).some((c: any) => c.id === first));
  assert.deepEqual(
    (await ops.recent(10, true)).map((c: any) => c.id),
    [first],
  );
  await ops.archiveChat(first, false);
  assert.ok((await ops.recent(10)).some((c: any) => c.id === first));
  assert.ok(logs.some((l) => l.includes('renamed "Renamed"')) && logs.some((l) => l.includes('restored')));
  await assert.rejects(ops.renameChat('nope', 'x'), /isn't in MoPilot/);
  await assert.rejects(ops.archiveChat('nope', true), /isn't in MoPilot/);
});

test('dictation says what it heard: the size, the type and whether the bytes are a WAV file', async () => {
  const { ops, logs } = rig();
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(100)]);
  assert.deepEqual(await ops.dictation.transcribe({ audio: wav, mime: 'audio/wav' }), {
    text: 'Heard 116 bytes of audio/wav: a WAV file.',
  });
  const caf = Buffer.concat([Buffer.from('caff'), Buffer.alloc(30)]);
  assert.deepEqual(await ops.dictation.transcribe({ audio: caf, mime: 'audio/wav' }), {
    text: 'Heard 34 bytes of audio/wav: NOT a WAV file, it starts 63 61 66 66.',
  });
  // a plain byte array reads the same as a Buffer
  assert.match(
    (await ops.dictation.transcribe({ audio: new Uint8Array(Buffer.from('RIFF\0\0\0\0WAVE')), mime: 'audio/wav' })).text,
    /: a WAV file\.$/,
  );
  assert.deepEqual(await ops.dictation.transcribe({ audio: Buffer.alloc(0), mime: undefined }), {
    text: 'Heard 0 bytes of an unknown type: NOT a WAV file, it starts nothing.',
  });
  assert.ok(logs.some((l: string) => /dictation: Heard 116 bytes of audio\/wav: a WAV file\./.test(l)));
});

test('the seeded waiting card closes when answered, and a Stop closes it too', async () => {
  const { ops, cardOf } = rig();
  assert.equal(await ops.answer({ chatId: 'dev-seed-waiting', approvalId: 'nope', choice: 'once' }), false);
  assert.equal(await ops.answer({ chatId: 'dev-seed-login', approvalId: 'a1', choice: 'once' }), false);
  const card = await cardOf('dev-seed-waiting');
  assert.equal(await ops.answer({ chatId: 'dev-seed-waiting', approvalId: card.id, choice: 'once' }), true);
  assert.equal(ops.turn('dev-seed-waiting'), 'idle');
  assert.equal(await cardOf('dev-seed-waiting'), undefined);
  await ops.stop('dev-seed-waiting');
});

test('a chat started from the phone streams, asks, runs the command once allowed and answers', async () => {
  const { app, ops, events, patches, cardOf, start, logs } = rig();
  const id = await start('summarize the diff\nsecond line', { projectId: 'dev-repo' });
  assert.equal(app.chats.get(id).title, 'summarize the diff');
  assert.equal(app.chats.get(id).project, 'dev-repo');
  await until(() => cardOf(id), 'the approval card');
  assert.equal(ops.turn(id), 'awaitingUser');
  const card = await cardOf(id);
  assert.deepEqual(
    card.choices.map((c: any) => c.key),
    ['once', 'deny'],
  );
  assert.equal(await ops.answer({ chatId: id, approvalId: card.id, choice: 'once' }), true);
  await app.idle();
  assert.equal(ops.turn(id), 'idle');
  const rows = (await ops.read(id)).rows;
  assert.deepEqual(
    rows.map((r: any) => r.role),
    ['user', 'assistant', 'step', 'assistant'],
  );
  assert.match(rows.at(-1).text, /2 changed entries/);
  // the feed carried the streamed text, the command with its output, and the turn ending
  const methods = events.map((e) => e.ev);
  assert.ok(methods.includes('items.append') && methods.includes('items.delta') && methods.includes('turn.state'));
  assert.ok(JSON.stringify(events).includes('src/price.ts'));
  assert.ok(patches.some((p) => p.patch.approvals?.length));
  assert.ok(logs.some((l) => l.includes(`${id} turn finished`)));
});

test('a denied command is not run, and the turn still ends with an answer', async () => {
  let ran = 0;
  const { app, ops, cardOf, start } = rig({ status: async () => (ran++, '') });
  const id = await start();
  await until(() => cardOf(id), 'the approval card');
  await ops.answer({ chatId: id, approvalId: (await cardOf(id)).id, choice: 'deny' });
  await app.idle();
  assert.equal(ran, 0);
  assert.match((await ops.read(id)).rows.at(-1).text, /did not run it/);
});

test('Stop ends the turn wherever it is: while streaming, at the card, running the command, and while streaming the result', async () => {
  const stopAll = (r: ReturnType<typeof rig>) => [...r.app.chats.keys()].forEach((id) => void r.ops.stop(id));
  const ended = (r: ReturnType<typeof rig>, id: string) => {
    assert.equal(r.ops.turn(id), 'idle');
    assert.ok(r.logs.some((l) => l.includes(`${id} turn stopped`)));
  };
  // streaming the opening note
  const hooks: { stop?: () => void } = {};
  const first = rig({ sleepHook: (n) => n === 2 && hooks.stop?.() });
  hooks.stop = () => stopAll(first);
  ended(first, await first.start().then(async (id) => (await first.app.idle(), id)));

  // at the card: the Stop denies it
  const second = rig();
  const b = await second.start();
  await until(() => second.cardOf(b), 'the card');
  await second.ops.stop(b);
  await second.app.idle();
  ended(second, b);

  // while the command runs
  const running: { stop?: () => void } = {};
  const third = rig({ status: async () => (running.stop?.(), 'x') });
  running.stop = () => stopAll(third);
  const c = await third.start();
  await until(() => third.cardOf(c), 'the card');
  await third.ops.answer({ chatId: c, approvalId: (await third.cardOf(c)).id, choice: 'once' });
  await third.app.idle();
  ended(third, c);

  // while the result streams, after allow and after deny
  for (const choice of ['once', 'deny']) {
    const late: { armed: boolean; stop?: () => void } = { armed: false };
    const fourth = rig({ sleepHook: () => late.armed && late.stop?.() });
    late.stop = () => stopAll(fourth);
    const d = await fourth.start();
    await until(() => fourth.cardOf(d), 'the card');
    late.armed = true;
    await fourth.ops.answer({ chatId: d, approvalId: (await fourth.cardOf(d)).id, choice });
    await fourth.app.idle();
    ended(fourth, d);
  }
});

test('a follow-up waits for the running turn; a failing command is logged and the chat can go on', async () => {
  let failures = 0;
  const { app, ops, cardOf, start, logs } = rig({
    status: async () => {
      // an Error the first time, a bare string the second
      throw ++failures === 1 ? new Error('git is gone') : 'plain failure';
    },
  });
  const id = await start();
  assert.deepEqual(await ops.send({ chatId: id, text: 'and then?' }), { warning: null });
  await until(() => cardOf(id), 'the first card');
  await ops.answer({ chatId: id, approvalId: (await cardOf(id)).id, choice: 'once' });
  await until(async () => (await cardOf(id)) && logs.some((l) => l.includes('turn failed: git is gone')), 'the second turn to ask');
  await ops.answer({ chatId: id, approvalId: (await cardOf(id)).id, choice: 'once' });
  await app.idle();
  assert.ok(logs.some((l) => l.includes('turn failed: plain failure')));
  assert.equal((await ops.read(id)).rows.filter((r: any) => r.role === 'user').length, 2);
  assert.equal(ops.turn(id), 'idle');
});

test('the menus and settings a phone reads or sets are answered', async () => {
  const { ops, logs } = rig();
  assert.deepEqual(await ops.harnesses(), HARNESSES);
  assert.equal(await ops.usable('codex'), true);
  assert.deepEqual(ops.projects(), [{ id: 'dev-repo', name: 'dev-repo' }]);
  // what the Mac starts on a schedule: soonest and later, one on a Host that fires while the Mac is away, one with no upcoming run
  assert.deepEqual(await ops.scheduled(), [
    { id: 's-standup', name: 'Daily standup digest', next: 5_000_000 + 25 * 60_000 },
    { id: 's-deps', name: 'Weekly dependency check', next: 5_000_000 + 26 * 3_600_000 },
    {
      id: 's-backup',
      name: 'Nightly backup of the notes folder',
      next: 5_000_000 + 5 * 3_600_000,
      hostId: 'ssh:studio',
      firesWhileMacAway: true,
    },
    { id: 's-retired', name: 'Quarterly reports export', next: 5_000_000 + 2 * 3_600_000, hostId: 'ssh:retired', firesWhileMacAway: false },
    { id: 's-paused', name: 'Monthly invoice export', next: null },
  ]);
  assert.equal((await ops.options({})).model, 'dev-fast');
  const typed = (await ops.commands({ chatId: 'dev-seed-readme' })).commands;
  assert.ok(typed.every((c: any) => c.as === 'text') && typed.some((c: any) => c.name === 'review'), 'a Claude chat types its commands');
  const skills = (await ops.commands({ chatId: 'dev-seed-waiting' })).commands;
  assert.ok(skills.length && skills.every((c: any) => c.as === 'skill'), 'a Codex chat carries skills beside the text');
  assert.ok(
    (await ops.commands({ harness: 'codex' })).commands.every((c: any) => c.as === 'skill'),
    'a new chat is asked by harness',
  );
  const at = await ops.mentionsList({ chatId: 'dev-seed-login', query: '' });
  assert.deepEqual(at.files, [], 'the fake repo is not a folder here');
  const others = (await ops.recent(200)).filter((c: any) => c.id !== 'dev-seed-login');
  assert.deepEqual(
    at.chats,
    others.slice(0, 3).map((c: any) => ({ id: c.id, title: c.title })),
    'the other chats, newest first',
  );
  assert.ok(
    at.chats.every((c: any) => c.id !== 'dev-seed-login'),
    'not the chat itself',
  );
  assert.equal(ops.pin('dev-seed-login', true), true);
  assert.equal((await ops.recent(10)).find((c: any) => c.id === 'dev-seed-login')?.pinned, true);
  assert.equal(ops.pin('nope', true), false);
  await ops.choose({ model: 'dev-deep', effort: null });
  await ops.permit({ value: 'auto-review' });
  await ops.switchHarness({ chatId: 'dev-seed-login', harness: 'claude' });
  assert.equal(await ops.dictation.engine(), 'unavailable');
  assert.deepEqual(await ops.dictation.transcribe(), { text: '' });
  assert.equal(ops.attach({ name: 'a.png' }).name, 'a.png');
  const kept = ops.attach({ name: 'a.png' }).id;
  assert.match(kept, /^[0-9a-f]{16}$/, 'an id the Mac schema accepts with a message');
  await ops.send({ chatId: 'dev-seed-login', text: 'with files', attachments: [kept, 'unknown'] });
  assert.ok(logs.some((l) => l.includes('send carries a.png, unknown')));
  assert.deepEqual(ops.browserSettings(), { ok: true });
  assert.equal(ops.open(), undefined);
  assert.equal((await ops.start({ harness: 'claude', text: '', projectId: null })).chatId.startsWith('dev-chat-'), true);
  assert.ok(logs.some((l) => l.includes('permission auto-review')) && logs.some((l) => l.includes('switch dev-seed-login to claude')));
});

test('with its own defaults it streams at word pace and runs the real git status', async () => {
  const repo = ensureRepo(path.join(scratch, 'real'));
  const app = createFakeApp({ repo });
  const events: any[] = [];
  app.bind({ attached: true, onFeedEvent: (e: any) => events.push(e), onSessionPatch: () => undefined });
  const { chatId } = await app.ops.start({ harness: 'codex', text: 'status', projectId: null });
  await until(async () => (await app.ops.cardsOf(chatId)).length, 'the card', 15_000);
  await app.ops.answer({ chatId, approvalId: (await app.ops.cardsOf(chatId))[0].id, choice: 'once' });
  await app.idle();
  assert.ok(JSON.stringify(events).includes('src/price.ts'), 'the real repository status reached the feed');
  assert.ok(((await app.ops.recent(10)).find((c: any) => c.id === chatId)?.at ?? 0) > 0);
});

test('the real git status reads as clean when git has nothing to say', async () => {
  const app = createFakeApp({ repo: path.join(scratch, 'not-a-repository'), sleep: async () => undefined });
  const events: any[] = [];
  app.bind({ attached: true, onFeedEvent: (e: any) => events.push(e), onSessionPatch: () => undefined });
  const { chatId } = await app.ops.start({ harness: 'codex', text: 'status', projectId: null });
  await until(async () => (await app.ops.cardsOf(chatId)).length, 'the card');
  await app.ops.answer({ chatId, approvalId: (await app.ops.cardsOf(chatId))[0].id, choice: 'once' });
  await app.idle();
  assert.ok(JSON.stringify(events).includes('(clean)'));
});

test('a Stop retires the follow-ups still waiting, and leaves no message or command open on the phone', async () => {
  const { app, ops, events, cardOf, start } = rig();
  const id = await start();
  await ops.send({ chatId: id, text: 'queued behind the first turn' });
  await until(() => cardOf(id), 'the card');
  await ops.stop(id);
  await app.idle();
  assert.equal((await ops.read(id)).rows.filter((r: any) => r.role === 'user').length, 1, 'the follow-up never became a message');
  assert.deepEqual(
    ops.state.get(id).queue.map((q: any) => q.text),
    ['queued behind the first turn'],
    'the Mac keeps it queued after a Stop, as the app does',
  );
  assert.equal(events.filter((e) => e.ev === 'turn.state' && e.started).length, 1, 'but its turn never ran');
  const text = JSON.stringify(events);
  assert.match(text, /declined/, 'the command that was waiting is closed');
  assert.equal(ops.turn(id), 'idle');
  // a chat that was stopped runs the next message normally
  await ops.send({ chatId: id, text: 'again' });
  await until(() => cardOf(id), 'the next card');
  await ops.stop(id);
  await app.idle();
});

test('a Stop in the middle of a streamed message keeps what was sent and ends the turn as interrupted', async () => {
  const hooks: { stop?: () => void } = {};
  const r = rig({ sleepHook: (n) => n === 3 && hooks.stop?.() });
  hooks.stop = () => [...r.app.chats.keys()].forEach((id) => void r.ops.stop(id));
  const id = await r.start();
  await r.app.idle();
  const snapshot = await r.ops.items(id, 5);
  assert.equal(snapshot.items[0].text, "I'll check the ", 'the message keeps what was sent');
  assert.equal(snapshot.liveTurn?.status, 'interrupted');
  assert.equal(r.ops.turn(id), 'idle');
});

test('a Stop at the card closes the command item under its own name, not a blank one', async () => {
  const { app, ops, events, cardOf, start } = rig();
  const id = await start();
  await until(() => cardOf(id), 'the card');
  await ops.stop(id);
  await app.idle();
  const closed = JSON.stringify(events).match(/"command":"git status --short"[^}]*"status":"declined"/);
  assert.ok(closed, 'the declined item still names the command');
});

test('a message to the seeded waiting chat retires its old card, and the new turn’s own card works', async () => {
  const { app, ops, cardOf } = rig();
  const old = await cardOf('dev-seed-waiting');
  assert.equal(old.detail, 'rm -rf dist coverage');
  await ops.send({ chatId: 'dev-seed-waiting', text: 'actually, list the files' });
  await until(async () => (await cardOf('dev-seed-waiting'))?.detail === 'git status --short', 'the new card');
  const fresh = await cardOf('dev-seed-waiting');
  assert.notEqual(fresh.id, old.id);
  assert.equal(await ops.answer({ chatId: 'dev-seed-waiting', approvalId: old.id, choice: 'once' }), false, 'the old card is gone');
  await ops.answer({ chatId: 'dev-seed-waiting', approvalId: fresh.id, choice: 'once' });
  await app.idle();
  assert.equal(ops.turn('dev-seed-waiting'), 'idle');
});

test('a script that was stopped before it shows anything shows nothing: no empty message, no card nobody can answer', async () => {
  const { app, ops, events, cardOf } = rig();
  const chat = app.add({ id: 'dev-stopped-script', title: 's', harness: 'codex', at: 1 });
  const logsBefore = events.length;
  await app.enqueue(chat, async (t: any) => {
    await ops.stop(chat.id);
    await t.ask({ title: 'never shown' });
  });
  assert.equal(await cardOf(chat.id), undefined);
  assert.equal(ops.turn(chat.id), 'idle');
  const second = app.add({ id: 'dev-stopped-say', title: 's', harness: 'codex', at: 1 });
  await app.enqueue(second, async (t: any) => {
    await ops.stop(second.id);
    await t.say('never shown');
  });
  assert.ok(!JSON.stringify(events.slice(logsBefore)).includes('never shown'));
  assert.ok(!JSON.stringify(events.slice(logsBefore)).includes('"agentMessage"'), 'no empty message item');
});

test('a card answered on the phone cannot also be answered on the Mac', async () => {
  const { app, ops, cardOf, start } = rig();
  const id = await start();
  await until(() => cardOf(id), 'the card');
  const card = await cardOf(id);
  assert.equal(app.macAnswers(id, 'once', 'a-different-card'), false, 'only the card it was meant for');
  assert.equal(await ops.answer({ chatId: id, approvalId: card.id, choice: 'once' }), true);
  assert.equal(app.macAnswers(id, 'once'), false, 'the phone already answered it');
  await app.idle();
});

test('the Mac pages back through a long chat: the rows before one it names, newest last, and whether there are more', async () => {
  const { app } = rig();
  const ops = app.ops;
  const id = 'dev-seed-login';
  const rows = (await ops.read(id)).rows;
  rows.length = 0;
  for (let i = 0; i < 100; i++) rows.push({ role: 'user', text: `row ${i}`, id: `${id}-row${i}` });
  const page = (await ops.older(id, 'dev-seed-login-row60', 40))!;
  assert.equal(page.rows.length, 40);
  assert.equal(page.rows.at(-1).id, 'dev-seed-login-row59', 'the page ends just before the named row');
  assert.equal(page.rows[0].id, 'dev-seed-login-row20');
  assert.equal(page.more, true);
  const last = (await ops.older(id, 'dev-seed-login-row10'))!;
  assert.equal(last.rows.length, 10, 'the default page holds up to 40 and stops at the start of the chat');
  assert.equal(last.more, false);
  assert.equal(await ops.older(id, 'no-such-row'), null, 'a row that is not in the chat is stale');
  await assert.rejects(ops.older('nope', 'x'), new RegExp(GONE));
});

test('a phone pages back through the remote service on the fake app, and a hidden or missing chat is gone', async () => {
  const { app } = rig();
  const id = 'dev-seed-login';
  const rows = (await app.ops.read(id)).rows;
  rows.length = 0;
  for (let i = 0; i < 100; i++) rows.push({ role: 'user', text: `row ${i}`, id: `${id}-row${i}` });
  const r = remoteRig({ ops: { older: app.ops.older, reachable: app.ops.reachable } });
  const phone = r.phone('p1');
  const page = await phone.ask('chat.read', { chatId: id, before: `${id}-row60`, limit: 40 });
  assert.equal(page.ok, true);
  assert.equal(page.result.rows.length, 40);
  assert.equal(page.result.more, true);
  const stale = await phone.ask('chat.read', { chatId: id, before: 'gone' });
  assert.equal(stale.error.code, 'stale');
  const momo = await phone.ask('chat.read', { chatId: 'dev-momo-main', before: 'x' });
  assert.equal(momo.ok, false, 'MoMo’s hidden chat is reached through momo.* only');
  await assert.rejects(app.ops.older('dev-momo-main', 'x'), new RegExp(GONE));
});

test('a sub-session of the README chat waits for the person: its card is answered like any, and the waiting clears', async () => {
  const { ops, cardOf } = rig();
  const state = () => ops.state.get('dev-seed-linked-ask').turn;
  assert.equal(state(), 'awaitingUser');
  const card = await cardOf('dev-seed-linked-ask');
  assert.deepEqual([card.title, card.detail], ['Edit this file?', 'docs/pricing.md']);
  await ops.answer({ chatId: 'dev-seed-linked-ask', approvalId: card.id, choice: 'once' });
  assert.notEqual(state(), 'awaitingUser');
});

test('a queued message whose turn a Stop retires after it was lined up sends nothing', async () => {
  const hook: { arm: boolean; stop: () => void } = { arm: false, stop: () => {} };
  const r = rig({
    // the next turn is lined up right after this line; the next clock read is its own
    onLog: (line) => void (line.includes('sends the queued message') && (hook.arm = true)),
    now: () => {
      // the Stop lands after the next turn is lined up and before it runs
      if (hook.arm) {
        hook.arm = false;
        hook.stop();
      }
      return 5_000_000;
    },
  });
  const id = await r.start();
  hook.stop = () => void r.ops.stop(id);
  await until(() => r.cardOf(id), 'the card');
  await r.ops.send({ chatId: id, text: 'later' });
  await r.ops.answer({ chatId: id, approvalId: (await r.cardOf(id)).id, choice: 'once' });
  await r.app.idle();
  assert.equal((await r.cardOf(id)) ?? null, null, 'the retired turn never asked for anything');
  assert.equal(r.logs.filter((l) => l.includes('turn failed')).length, 0);
});
