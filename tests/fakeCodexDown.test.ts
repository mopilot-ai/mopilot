// Exercises the scripted Codex fixture's ways of going down (quitting as it starts or when told, the CRASH turn) and the
// rollout files it writes, read back with the app's own rollout reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrashTurn, createRollouts, rolloutLines, rolloutPath, startOrQuit, watchQuit } from './e2e/fixtures/fake-codex-down.mjs';
import { parseRollout } from './support/rollout.ts';
import { waitFor } from './support/waitFor.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-down-'));
const sink = () => {
  const logged: any[] = [];
  return { logged, log: (e: any) => logged.push(e) };
};
const until = async (ok: () => boolean) => {
  await waitFor(ok);
  assert.ok(ok());
};

function thread(id: string, turns: any[], extra: Record<string, unknown> = {}) {
  return {
    thread: { id, cwd: '/work/repo', cliVersion: '9.0.0', createdAt: Date.UTC(2026, 9, 21, 12, 0, 0) / 1000, ephemeral: false },
    turns,
    title: false,
    ...extra,
  };
}
const user = (text: string) => ({ type: 'userMessage', id: `u-${text}`, content: [{ type: 'text', text }] });
const agent = (text: string) => ({ type: 'agentMessage', id: `a-${text}`, text });
const turn = (id: string, status: string, items: any[]) => ({ id, status, items, startedAt: 1_000, completedAt: 1_001, durationMs: 5 });

test('every start is logged; a copy told to quit as it starts exits before it answers', () => {
  const dir = tmp();
  const exits: number[] = [];
  const err: string[] = [];
  const stderr = { write: (s: string) => err.push(s) };
  const exit = (code: number) => void exits.push(code);
  const up = sink();
  assert.equal(startOrQuit({ log: up.log, version: '9.0.0', env: {}, exit, stderr }), false);
  assert.deepEqual(up.logged, [{ id: null, method: 'fake/start', params: { version: '9.0.0' } }]);
  assert.deepEqual(exits, []);

  const quits = sink();
  assert.equal(startOrQuit({ log: quits.log, version: '9.1.0', env: { FAKE_CODEX_QUIT_ON_START: '1' }, exit, stderr }), true);
  assert.deepEqual(
    quits.logged.map((e) => [e.method, e.params.version]),
    [
      ['fake/start', '9.1.0'],
      ['fake/quit', '9.1.0'],
    ],
  );
  assert.deepEqual(exits, [1]);
  assert.deepEqual(err, ['fake-codex 9.1.0: quitting as it starts\n']);

  // brought down by the test: only while $FAKE_CODEX_LOG.down is there
  const log = path.join(dir, 'fake-codex.jsonl');
  assert.equal(startOrQuit({ log: sink().log, version: '1', env: { FAKE_CODEX_LOG: log }, exit, stderr }), false);
  fs.writeFileSync(`${log}.down`, '');
  assert.equal(startOrQuit({ log: sink().log, version: '1', env: { FAKE_CODEX_LOG: log }, exit, stderr }), true);
  assert.deepEqual(exits, [1, 1]);
});

test('a running app-server quits once $FAKE_CODEX_LOG.quit appears, and removes it', async () => {
  assert.equal(watchQuit({ log: () => {}, env: {} }), null);
  const log = path.join(tmp(), 'fake-codex.jsonl');
  const exits: number[] = [];
  const s = sink();
  const timer = watchQuit({ log: s.log, env: { FAKE_CODEX_LOG: log }, exit: (c: number) => void exits.push(c), everyMs: 2 });
  assert.ok(timer);
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(exits, []);
  fs.writeFileSync(`${log}.quit`, '');
  await until(() => exits.length === 1);
  assert.equal(fs.existsSync(`${log}.quit`), false);
  assert.deepEqual(s.logged, [{ id: null, method: 'fake/quit', params: null }]);
  // the poll stopped with it
  fs.writeFileSync(`${log}.quit`, '');
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(exits, [1]);
});

test("a rollout reads back as the turns the app-server had, each turn's end as it was", () => {
  const rec = thread('t1', [
    turn('k1', 'completed', [user('first'), agent('fake-codex: first'), { type: 'reasoning', id: 'r' }]),
    turn('k2', 'interrupted', [user('second')]),
    turn('k3', 'inProgress', [user('third')]),
  ]);
  const history = parseRollout(rolloutLines(rec));
  assert.equal(history.cwd, '/work/repo');
  assert.deepEqual(
    history.turns.map((t: any) => [t.id, t.status, t.items.map((i: any) => i.text ?? i.content[0].text)]),
    [
      ['k1', 'completed', ['first', 'fake-codex: first']],
      ['k2', 'interrupted', ['second']],
      ['k3', 'inProgress', ['third']],
    ],
  );
  // a user message with no content, and a turn with no times, still write
  const bare = thread('t2', [{ id: 'k', status: 'completed', items: [{ type: 'userMessage', id: 'u' }] }]);
  assert.match(rolloutLines(bare), /"user_message","turn_id":"k","message":""/);
});

test('rollouts go in the day folder of when the thread started, written when they change, never for title or ephemeral threads', () => {
  const home = tmp();
  const rec = thread('t1', [turn('k1', 'completed', [user('hi'), agent('fake-codex: hi')])]);
  const file = rolloutPath(home, rec.thread);
  const d = new Date(rec.thread.createdAt * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  assert.equal(path.dirname(file), path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  assert.match(path.basename(file), /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-t1\.jsonl$/);

  // off unless asked for
  createRollouts({ codexHome: home, env: {} })(new Map([['t1', rec]]));
  assert.equal(fs.existsSync(file), false);

  const write = createRollouts({ codexHome: home, env: { FAKE_CODEX_ROLLOUTS: '1' } });
  const title = thread('t2', [turn('k', 'completed', [user('name it')])], { title: true });
  const ephemeral = thread('t3', [turn('k', 'completed', [user('aside')])]);
  ephemeral.thread.ephemeral = true;
  const empty = thread('t4', []);
  const threads = new Map<string, any>([
    ['t1', rec],
    ['t2', title],
    ['t3', ephemeral],
    ['t4', empty],
  ]);
  write(threads);
  assert.equal(fs.readFileSync(file, 'utf8'), rolloutLines(rec));
  for (const t of [title, ephemeral, empty]) assert.equal(fs.existsSync(rolloutPath(home, t.thread)), false);
  // unchanged: left as it is (a test may have removed it); changed: written again
  fs.rmSync(file);
  write(threads);
  assert.equal(fs.existsSync(file), false);
  rec.turns.push(turn('k2', 'completed', [user('again'), agent('fake-codex: again')]));
  write(threads);
  assert.equal(parseRollout(fs.readFileSync(file, 'utf8')).turns.length, 2);
});

test('the CRASH turn says it is working, asks once told to, then quits mid-turn once told to', async () => {
  const log = path.join(tmp(), 'fake-codex.jsonl');
  const notes: any[] = [];
  const asks: any[] = [];
  const exits: number[] = [];
  let saved = 0;
  const s = sink();
  const crashTurn = createCrashTurn({
    notify: (method: string, params: any) => notes.push({ method, params }),
    ask: (method: string, params: any) => asks.push({ method, params }),
    log: s.log,
    saveState: () => void saved++,
    env: { FAKE_CODEX_LOG: log },
    exit: (c: number) => void exits.push(c),
    everyMs: 2,
  });
  const rec = thread('t1', []);
  const t: any = { id: 'k1', items: [] };
  const done = crashTurn(rec, t, () => 42);
  assert.equal(saved, 1);
  assert.equal(t.items[0].text, 'working on it');
  assert.deepEqual(
    notes.map((n) => n.method),
    ['item/started', 'item/agentMessage/delta'],
  );
  assert.equal(notes[0].params.item.text, '');
  assert.equal(notes[1].params.delta, 'working on it');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asks.length, 0);
  fs.writeFileSync(`${log}.ask`, '');
  await until(() => asks.length === 1);
  assert.equal(asks[0].method, 'item/commandExecution/requestApproval');
  assert.equal(asks[0].params.command, 'rm -rf build');
  assert.equal(asks[0].params.cwd, '/work/repo');
  assert.equal(fs.existsSync(`${log}.ask`), false);
  fs.writeFileSync(`${log}.crash`, '');
  await done;
  assert.deepEqual(exits, [1]);
  assert.deepEqual(s.logged, [{ id: null, method: 'fake/crash', params: null }]);
  assert.equal(fs.existsSync(`${log}.crash`), false);
});
