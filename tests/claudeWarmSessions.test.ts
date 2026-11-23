// electron/harness/claude/warm.cjs warm (#1830), against a fake Agent SDK: an existing chat opened after its CLI ended gets a CLI
// resuming its session before it sends. The send uses it; one never sent to ends silently and lets the next CLI speak; a
// write by another app meanwhile makes the send resume afresh; nothing starts on a live or starting key or under pressure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakes, load, fakeBin, until, home, lastQuery } from './support/electron-claude.ts';

const { WARM_IDLE_MS } = createRequire(import.meta.url)('../electron/harness/claude/governor.cjs');

const bin = fakeBin('warm/claude');
const user = (text: string) => ({ role: 'user', content: text });
const projects = path.join(home, '.claude', 'projects', 'w');
fs.mkdirSync(projects, { recursive: true });
const transcript = (sid: string, rows: any[]) =>
  fs.writeFileSync(path.join(projects, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const appendRows = (sid: string, rows: any[]) =>
  fs.appendFileSync(path.join(projects, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const of = (t: any, key: string, kind: string) => t.events.filter((e: any) => e.key === key && e.kind === kind);
const results = (t: any, key: string) => of(t, key, 'message').filter((e: any) => e.msg.type === 'result').length;
const answering = (q: any) => {
  q.reply = () => [{ type: 'result' }];
};
const opts = (sid: string) => ({ bin, sessionId: sid, resume: true, cwd: home, account: 'default', chatId: `chat-${sid}` });

test("an opened chat's CLI resumes its session before the send and says nothing; the send uses it and its events are the chat's", async () => {
  const t = load();
  const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const key = `claude:${sid}`;
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  fakes.onQuery = answering;
  const before = fakes.queries.length;
  assert.equal(await t.claude.turnApi.warm(key, opts(sid)), true);
  const q = lastQuery();
  assert.equal(q.options.resume, sid);
  assert.deepEqual(q.inputs, [], 'nothing is sent before the chat sends');
  assert.equal(await t.claude.turnApi.warm(key, opts(sid)), false, 'a live key starts nothing');
  await t.claude.send(key, opts(sid), user('one'));
  await until('the reply reaches the windows', () => results(t, key) === 1);
  assert.equal(fakes.queries.length - before, 1, 'no second CLI');
  await t.call('claude:control', key, 'close');
  await until('its end, reported as the chat’s', () => of(t, key, 'closed').length === 1);
});

test('A3: a send while the CLI is still warming waits for it and uses it; a second warm meanwhile starts nothing', async () => {
  const t = load();
  const sid = 'aaaaaaaa-0000-4000-8000-000000000002';
  const key = `claude:${sid}`;
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  fakes.onQuery = answering;
  const before = fakes.queries.length;
  const warming = t.claude.turnApi.warm(key, opts(sid));
  assert.equal(await t.claude.turnApi.warm(key, opts(sid)), false);
  const sending = t.claude.send(key, opts(sid), user('one'));
  await Promise.all([warming, sending]);
  await until('the reply', () => results(t, key) === 1);
  assert.equal(fakes.queries.length - before, 1);
  await t.call('claude:control', key, 'close');
});

test('I: another app writing the transcript after the warm makes the send resume afresh, the warmed CLI ending quietly', async () => {
  const t = load();
  const sid = 'aaaaaaaa-0000-4000-8000-000000000003';
  const key = `claude:${sid}`;
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  fakes.onQuery = answering;
  fakes.run = () => ({ err: new Error('no ps') });
  await t.claude.turnApi.warm(key, opts(sid));
  const warmed = lastQuery();
  appendRows(sid, [{ type: 'user', uuid: 'x1', parentUuid: 'u0', message: { content: 'from the terminal' } }]);
  await t.claude.send(key, opts(sid), user('one'));
  assert.notEqual(lastQuery(), warmed);
  assert.ok(warmed.closed);
  await until('the reply', () => results(t, key) === 1);
  assert.equal(of(t, key, 'closed').length, 0, 'the replaced CLI says nothing');
  await t.call('claude:control', key, 'close');
});

test('B4: a warmed CLI never sent to ends silently after WARM_IDLE_MS, and the next CLI on the key speaks', async () => {
  const t = load();
  const sid = 'aaaaaaaa-0000-4000-8000-000000000004';
  const key = `claude:${sid}`;
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  fakes.onQuery = answering;
  t.claude.timing.retireMs = 50;
  await t.claude.turnApi.warm(key, opts(sid));
  const warmed = lastQuery();
  t.claude.reap(Date.now() + WARM_IDLE_MS - 60_000);
  assert.equal(t.claude.turnApi.isLive(key), true);
  t.claude.reap(Date.now() + WARM_IDLE_MS + 60_000);
  await until('the warmed CLI to end', () => warmed.closed && !t.claude.turnApi.isLive(key));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([...of(t, key, 'closed'), ...of(t, key, 'error')], []);
  await t.claude.send(key, opts(sid), user('one'));
  await until('the new CLI’s reply', () => results(t, key) === 1);
  await t.call('claude:control', key, 'close');
  await until('its end, heard', () => of(t, key, 'closed').length === 1);
});

test('nothing warms under memory pressure; a warm that fails leaves nothing starting and the send reports its own', async () => {
  const t = load();
  const sid = 'aaaaaaaa-0000-4000-8000-000000000005';
  const key = `claude:${sid}`;
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  fakes.onQuery = answering;
  let level: any = 'critical';
  t.claude.governor.watch({ level: () => level, subscribe: () => () => {} });
  assert.equal(await t.claude.turnApi.warm(key, opts(sid)), false);
  level = null;
  await assert.rejects(t.claude.turnApi.warm(key, { ...opts(sid), bin: '/nowhere/claude' }), /not installed/);
  assert.equal(t.claude.turnApi.isLive(key), false);
  await t.claude.send(key, opts(sid), user('one'));
  await until('the reply', () => results(t, key) === 1);
  await t.call('claude:control', key, 'close');
  await until('its end, heard', () => of(t, key, 'closed').length === 1);
});

test('A4: a warm on a key whose CLI is still ending waits for it to quit, then resumes', async () => {
  const t = load();
  t.claude.timing.retireMs = 50;
  const sid = 'aaaaaaaa-0000-4000-8000-000000000006';
  const key = `claude:${sid}`;
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  fakes.onQuery = answering;
  await t.claude.send(key, opts(sid), user('one'));
  await until('the reply', () => results(t, key) === 1);
  const first = lastQuery();
  // the reaper ends it; the warm comes while it is still ending
  t.claude.reap(Date.now() + 2 * 60 * 60_000);
  assert.equal(t.claude.turnApi.isLive(key), false);
  assert.equal(await t.claude.turnApi.warm(key, opts(sid)), true);
  assert.ok(first.closed, 'the old CLI quit before the new one started');
  assert.notEqual(lastQuery(), first);
  await t.call('claude:control', key, 'close');
});
