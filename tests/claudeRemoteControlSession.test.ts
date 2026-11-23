// Remote Control wired into the Claude Code sessions in main (electron/harness/claude/index.cjs): the control request, a process that starts
// and ends, the link remembered across app runs, and the Settings switch over IPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, flush, until, lastQuery } from './support/electron-claude.ts';

const bin = fakeBin('rc/claude');
const user = (text: string) => ({ role: 'user', content: text });
const answer = (id: string) => ({ session_url: `https://claude.ai/code/session_${id}`, bridge_session_id: `cse_${id}`, bridge_epoch: 1 });
const rcEvents = (t: any) => t.events.filter((e: any) => e.kind === 'remoteControl');

/** Every query the fake SDK starts can bridge: it records the call and answers with a link for `id`. */
function bridging(id = 'one') {
  fakes.onQuery = (q: any) => {
    q.enableRemoteControl = async (...a: any[]) => (q.calls.push(['enableRemoteControl', ...a]), a[0] ? answer(id) : undefined);
  };
}

test('the control request links a running session and the chat hears each step; the end of the process takes the link down', async () => {
  const t = load();
  bridging();
  const key = 'claude:rc1';
  assert.equal(await t.call('claude:control', key, 'remoteControl', { on: true }), null);
  await t.claude.send(key, { bin, sessionId: 'rc1', cwd: '/work/app' }, user('hi'));
  await until('the reply', () => !t.claude.ownBusy(key));
  const view = await t.call('claude:control', key, 'remoteControl', { on: true, title: 'Fix the build' });
  assert.deepEqual(view, { state: 'on', url: 'https://claude.ai/code/session_one', error: null, wanted: true });
  assert.deepEqual(
    lastQuery().calls.find((c: any[]) => c[0] === 'enableRemoteControl'),
    ['enableRemoteControl', true, 'Fix the build', { keepSessionOnExit: true }],
  );
  assert.deepEqual(
    rcEvents(t).map((e: any) => [e.key, e.state]),
    [
      [key, 'connecting'],
      [key, 'on'],
    ],
  );
  await t.call('claude:control', key, 'close');
  await until('the end', () => rcEvents(t).at(-1)?.state === 'off');
  assert.equal(rcEvents(t).at(-1).url, null);
  await flush();
});

test('a link the user had on is reattached by the next app run, and an off stays off', async () => {
  const t = load();
  bridging('two');
  fs.writeFileSync(
    path.join(t.userData, 'claude-remote-control.json'),
    JSON.stringify({ connectNew: false, choices: { on1: { on: true, bridge: 'cse_old' }, off1: { on: false } } }),
  );
  await t.claude.send('claude:on1', { bin, sessionId: 'on1', resume: true, cwd: '/work/app' }, user('hi'));
  const q = lastQuery();
  q.push({ type: 'system', subtype: 'init', tools: [] });
  await until('the reattach', () => rcEvents(t).some((e: any) => e.state === 'on'));
  assert.deepEqual(
    q.calls.find((c: any[]) => c[0] === 'enableRemoteControl'),
    ['enableRemoteControl', true, 'app', { keepSessionOnExit: true, reattachSessionId: 'cse_old' }],
  );
  await until('the reply', () => !t.claude.ownBusy('claude:on1'));

  await t.claude.send('claude:off1', { bin, sessionId: 'off1', resume: true, cwd: '/work/app' }, user('hi'));
  const other = lastQuery();
  other.push({ type: 'system', subtype: 'init', tools: [] });
  await until('the reply', () => !t.claude.ownBusy('claude:off1'));
  assert.equal(
    other.calls.some((c: any[]) => c[0] === 'enableRemoteControl'),
    false,
  );
  await t.call('claude:control', 'claude:on1', 'close');
  await t.call('claude:control', 'claude:off1', 'close');
  await flush();
});

test("the Settings switch links each new session at its start, and a CLI without the call fails that session's link, not the session", async () => {
  const t = load();
  bridging('three');
  assert.equal(await t.call('claude:remoteControlDefault'), false);
  assert.equal(await t.call('claude:setRemoteControlDefault', true), true);
  assert.equal(await t.call('claude:remoteControlDefault'), true);
  await t.claude.send('claude:new1', { bin, sessionId: 'new1', cwd: '/work/app' }, user('hi'));
  lastQuery().push({ type: 'system', subtype: 'init', tools: [] });
  await until('the link', () => rcEvents(t).some((e: any) => e.state === 'on' && e.key === 'claude:new1'));
  await until('the reply', () => !t.claude.ownBusy('claude:new1'));
  await t.call('claude:control', 'claude:new1', 'close');

  // an older CLI: no enableRemoteControl on the query
  fakes.onQuery = () => {};
  const before = rcEvents(t).length;
  await t.claude.send('claude:new2', { bin, sessionId: 'new2', cwd: '/work/app' }, user('hi'));
  lastQuery().push({ type: 'system', subtype: 'init', tools: [] });
  await until('the failure', () =>
    rcEvents(t)
      .slice(before)
      .some((e: any) => e.state === 'error' && e.key === 'claude:new2'),
  );
  await until('the reply', () => !t.claude.ownBusy('claude:new2'));
  await t.call('claude:control', 'claude:new2', 'close');
  await flush();
});

const saved = (t: any) => JSON.parse(fs.readFileSync(path.join(t.userData, 'claude-remote-control.json'), 'utf8')).choices;
/** A session whose link is up, ready for the archive, delete and quit paths. */
async function linked(t: any, id: string) {
  bridging(id);
  const key = `claude:${id}`;
  await t.claude.send(key, { bin, sessionId: id, cwd: '/work/app' }, user('hi'));
  await until('the reply', () => !t.claude.ownBusy(key));
  await t.call('claude:control', key, 'remoteControl', { on: true });
  return { key, q: lastQuery() };
}

test('archiving a chat takes its link down before its CLI ends, and forgets it', async () => {
  const t = load();
  t.claude.timing.retireMs = 20;
  const { key, q } = await linked(t, 'arch1');
  assert.equal(saved(t).arch1.on, true);
  assert.equal(t.claude.retireChat(key), 1);
  await until('the end', () => q.closed);
  const order = q.calls.map((c: any[]) => (c[0] === 'enableRemoteControl' ? `rc:${c[1]}` : c[0]));
  assert.deepEqual(order.slice(-2), ['rc:false', 'close']);
  assert.equal(
    rcEvents(t).some((e: any) => e.state === 'off'),
    true,
  );
  assert.equal(saved(t).arch1, undefined);
});

test('archiving a chat whose link will not come down still ends the CLI; one with no link ends at once', async () => {
  const t = load();
  t.claude.timing.retireMs = 20;
  const { key, q } = await linked(t, 'arch2');
  q.enableRemoteControl = async () => {
    throw new Error('bridge gone');
  };
  t.claude.retireChat(key);
  await until('the end', () => q.closed);
  assert.equal(saved(t).arch2, undefined);
  await t.claude.send('claude:arch3', { bin, sessionId: 'arch3', cwd: '/work/app' }, user('hi'));
  const plain = lastQuery();
  await until('the reply', () => !t.claude.ownBusy('claude:arch3'));
  t.claude.retireChat('claude:arch3');
  await until('the end', () => plain.closed);
});

test('deleting a chat takes its link down and forgets it', async () => {
  const t = load();
  t.claude.timing.retireMs = 20;
  const { q } = await linked(t, 'del1');
  await t.claude.deleteSession('del1');
  assert.equal(
    q.calls.some((c: any[]) => c[0] === 'enableRemoteControl' && c[1] === false),
    true,
  );
  assert.equal(saved(t).del1, undefined);
});

test('quitting the app keeps the saved bridge for the next run to reattach', async () => {
  const t = load();
  const { q } = await linked(t, 'quit1');
  await t.claude.closeAll(10);
  await until('the end', () => q.closed);
  assert.equal(
    q.calls.some((c: any[]) => c[0] === 'enableRemoteControl' && c[1] === false),
    false,
  );
  assert.deepEqual(saved(t).quit1, { on: true, bridge: 'cse_quit1', account: 'default' });
});

test('a /clear carries the link to the new chat; the old chat is released like an archived one', async () => {
  const t = load();
  t.claude.timing.retireMs = 20;
  const { key, q } = await linked(t, 'old1');
  assert.equal(t.claude.retireChat(key, { cleared: true }), 1);
  await until('the end', () => q.closed);
  assert.equal(saved(t).old1, undefined);
  await t.claude.send('claude:new1', { bin, sessionId: 'new1', cwd: '/work/app' }, user('hi'));
  const fresh = lastQuery();
  fresh.push({ type: 'system', subtype: 'init', tools: [] });
  await until('the link', () => rcEvents(t).some((e: any) => e.key === 'claude:new1' && e.state === 'on'));
  assert.equal(
    fresh.calls.some((c: any[]) => c[0] === 'enableRemoteControl' && c[1] === true),
    true,
  );
});

test('the app hears the network from Electron: offline shows the link waiting, online brings it back', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setInterval'] });
  const t = load();
  const { key } = await linked(t, 'net1');
  fakes.online = false;
  ctx.mock.timers.tick(15_000);
  await until('the wait', () => rcEvents(t).at(-1)?.state === 'offline');
  fakes.online = true;
  ctx.mock.timers.tick(15_000);
  await until('the link', () => rcEvents(t).at(-1)?.state === 'on');
  await t.call('claude:control', key, 'close');
});
