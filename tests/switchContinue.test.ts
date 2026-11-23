// A chat that came back to this Mac from another Host (electron/session/switchContinue.cjs, host/continueInbox.cjs): its next message opens a new native session in the folder the user picked with the other Host's handoff in front of it, once (3.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';
import { buildTurns } from './support/claude-translate.ts';

const require = createRequire(import.meta.url);
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { createContinueInbox, createLazyContinueInbox } = require('../electron/host/continueInbox.cjs');

const claudeTranscript = (user: string, reply: string) => [
  { type: 'user', uuid: 'u0', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: user } },
  {
    type: 'assistant',
    uuid: 'a0',
    timestamp: '2026-01-01T00:00:05Z',
    message: { id: 'm0', role: 'assistant', content: [{ type: 'text', text: reply }] },
  },
];

function setup(
  o: { ended?: any[]; pending?: any; startFails?: boolean; commitFails?: boolean; accountFails?: boolean; endFails?: boolean } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-continue-'));
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const log: string[] = [];
  const events: any[] = [];
  const sessions: [string, any][] = [];
  const doneFor: string[] = [];
  const ref = (id: string) => {
    const seg = chats.record(id).segments.at(-1);
    return { kind: seg.kind, id: seg.nativeId, instance: null, key: seg.kind === 'codex' ? seg.nativeId : `${seg.kind}:${seg.nativeId}` };
  };
  if (o.commitFails) chats.commit = () => false;
  const runner = new SwitchRunner({
    chats,
    ref,
    invalidate: () => log.push('invalidate'),
    claim: (k: string) => log.push(`claim ${k}`),
    unclaim: (k: string) => log.push(`unclaim ${k}`),
    changed: (id: string) => log.push(`changed ${id}`),
    prefs: () => ({ permission: 'default', serviceTier: null, claudeBin: null }),
    home: '/home/me',
    emit: (e: any, target: any) => events.push({ ...e, target }),
    git: { info: async () => null, status: async () => null },
    codex: {
      startThread: async () => ({ thread: { id: 'cx' } }),
      ensureResumed: async () => {},
      threadTurns: async () => ({ data: [], nextCursor: null }),
      summarize: async () => '',
      cwdOf: () => '/repo',
    },
    claude: {
      registerSession: (key: string, info: any) => {
        if (o.startFails) throw new Error('claude is not installed');
        sessions.push([key, info]);
      },
      isFresh: () => false,
      cwdOf: () => '/repo',
      accountOf: () => 'default',
      allTurns: async (_id: string, read: any) => buildTurns(claudeTranscript('fix the login bug', 'Fixed it.'), read.chatId, read.cwd),
      summarize: async () => '',
    },
    permissionParams: () => ({}),
    putAccount: o.accountFails ? async () => Promise.reject(new Error('no account')) : undefined,
    segmentEnded: o.endFails
      ? () => {
          throw new Error('handler broke');
        }
      : o.ended
        ? (e: any) => o.ended?.push(e)
        : undefined,
    continues: o.pending === undefined ? undefined : { pending: () => o.pending, done: (id: string) => doneFor.push(id) },
  });
  return { runner, chats, log, events, sessions, doneFor, dir };
}
const wait = { harness: 'claude', cwd: '/srv/app', text: '<sage-handoff from="Claude Code" mode="auto">the record</sage-handoff>' };
const seed = (chats: any) =>
  chats.commit({
    ...chats.record('c1'),
    segments: [{ kind: 'claude', nativeId: 'old', instance: null, provider: null, model: 'opus', start: 0, count: null }],
  });

test('the next message of a chat that came back opens a new session in the picked folder, with the handoff in front, and the handoff is used once', async () => {
  const t = setup({ pending: wait });
  seed(t.chats);
  const ps = t.runner.pendingContinue('c1');
  assert.deepEqual(ps, { harness: 'claude', continue: wait });
  const out = await t.runner.perform('c1', ps, 7);
  assert.equal(out.ready, true);
  assert.equal(out.prefix, wait.text);
  assert.deepEqual(out.note, { kind: 'switch', text: 'Continued on this Mac', handoff: wait.text });
  const segs = t.chats.record('c1').segments;
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].nativeId, segs[0].start, segs[0].count], ['old', 0, 1]);
  assert.deepEqual([segs[1].kind, segs[1].start, segs[1].count, segs[1].model], ['claude', 1, null, null]);
  assert.deepEqual([segs[1].handoff.mode, segs[1].handoff.text], ['continue', wait.text]);
  assert.deepEqual(t.sessions[0][1], { cwd: '/srv/app' });
  assert.deepEqual(t.doneFor, ['c1']);
  assert.ok(t.log.includes('invalidate') && t.log.includes('changed c1'));
  assert.ok(t.log.some((l) => l.startsWith('unclaim claude:')));
  assert.equal(t.events[0].kind, 'switched');
  assert.equal(t.events[0].harness, 'claude');
  assert.equal(t.events[0].fresh, true);
});

test('the segment the chat leaves is named as the old one when the switch ends it', async () => {
  const ended: any[] = [];
  const t = setup({ pending: wait, ended });
  seed(t.chats);
  await t.runner.perform('c1', t.runner.pendingContinue('c1'), 7);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].from.id, 'old');
  assert.notEqual(ended[0].to.id, 'old');
});

test('a Codex chat that came back opens a new thread in the picked folder, with the handoff in front', async () => {
  const t = setup({ pending: { ...wait, harness: 'codex' } });
  t.chats.commit({
    ...t.chats.record('c1'),
    segments: [{ kind: 'codex', nativeId: 'old-thread', instance: null, provider: null, model: 'gpt', start: 0, count: null }],
  });
  const out = await t.runner.perform('c1', t.runner.pendingContinue('c1'), 7);
  assert.equal(out.ready, true);
  assert.equal(out.prefix, wait.text);
  const segs = t.chats.record('c1').segments;
  assert.deepEqual([segs[1].kind, segs[1].nativeId], ['codex', 'cx']);
  assert.deepEqual(t.doneFor, ['c1']);
});

test('a chat with nothing waiting has no pending continue; a runner without an inbox never has one', () => {
  assert.equal(setup({ pending: null }).runner.pendingContinue('c1'), null);
  assert.equal(setup().runner.pendingContinue('c1'), null);
});

test('a session that cannot start, a chat file that cannot be saved: the message stays queued and the handoff waits for the next try', async () => {
  const a = setup({ pending: wait, startFails: true });
  seed(a.chats);
  const failed = await a.runner.perform('c1', a.runner.pendingContinue('c1'), 7);
  assert.equal(failed.ready, false);
  assert.match(failed.error, /Couldn't start Claude Code: claude is not installed/);
  assert.deepEqual(a.doneFor, []);
  assert.equal(a.chats.record('c1').segments.length, 1);
  const b = setup({ pending: wait, commitFails: true });
  seed(b.chats);
  b.chats.commit = () => false;
  const unsaved = await b.runner.perform('c1', b.runner.pendingContinue('c1'), 7);
  assert.equal(unsaved.ready, false);
  assert.match(unsaved.error, /could not save/);
  assert.deepEqual(b.doneFor, []);
});

test('a chat file the disk refuses (the core writes it): a switch and a continue say why, and the chat and its queue stay as they were', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const s = setup({ pending: wait });
  seed(s.chats);
  const threads = path.join(s.dir, 'threads');
  t.after(() => fs.chmodSync(threads, 0o700));
  fs.chmodSync(threads, 0o500);
  const refused = await s.runner.perform('c1', { harness: 'codex', model: 'gpt', modelLabel: 'GPT', mode: 'workspace' }, 7);
  assert.equal(refused.ready, false);
  assert.match(refused.error, /^The chat could not save its new session \(EACCES: permission denied, open '.*\.tmp'\)/);
  const unsaved = await s.runner.perform('c1', s.runner.pendingContinue('c1'), 7);
  assert.equal(unsaved.ready, false);
  assert.match(unsaved.error, /^EACCES: permission denied, open '.*\.tmp' Your message is kept in the queue\.$/);
  assert.deepEqual(s.doneFor, []);
  assert.deepEqual(
    s.chats.record('c1').segments.map((g: any) => g.nativeId),
    ['old'],
  );
  fs.chmodSync(threads, 0o700);
  assert.deepEqual(fs.readdirSync(threads), ['c1.v2']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(threads, 'c1.v2'), 'utf8')).segments.length, 1);
});

test('an account that cannot be put on the new session, or a segment-end handler that breaks, does not undo the continue', async () => {
  const t = setup({ pending: wait, accountFails: true, endFails: true });
  seed(t.chats);
  const out = await t.runner.perform('c1', t.runner.pendingContinue('c1'), 7);
  assert.equal(out.ready, true);
  assert.deepEqual(t.doneFor, ['c1']);
  assert.ok(t.events.some((e) => e.kind === 'toast' && /account/.test(e.text)));
});

test('the controller settles a pending continue before the message goes out, and a continue that did not settle is not shown as a pending switch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-continue-ctl-'));
  const state = new SessionStore();
  const starts: any[] = [];
  let ready = false;
  const c = new ChatController({
    state,
    chats: new ChatsStore(path.join(dir, 'threads')),
    onStopped: () => undefined,
    codex: {
      startTurn: async (chatId: string, _ref: any, item: any) => (starts.push([chatId, item.text, item.opts.prefix]), { started: true }),
    },
    claudeTurns: {},
    acpTurns: {},
    switcher: {
      pendingContinue: () => ({ harness: 'codex', continue: wait }),
      perform: async () => (ready ? { ready: true, prefix: 'THE RECORD' } : { ready: false, error: 'not yet' }),
    },
    claude: {},
    acp: {},
  });
  c.send('t1', { text: 'hello', attachments: [], opts: { human: true } }, 1);
  await tick();
  await tick();
  assert.deepEqual(starts, []);
  assert.equal(state.get('t1').pendingSwitch, null, 'the chip is for a switch the user chose');
  ready = true;
  c.send('t1', { text: 'again', attachments: [], opts: { human: true } }, 1);
  await tick();
  await tick();
  assert.deepEqual((starts as any[]).at(-1)?.slice(0, 1), ['t1']);
});

test("the inbox: a handoff is prepared, bound when the chat is this Mac's, found again after a restart, and gone once used", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-inbox-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-inbox-folder-'));
  const inbox = createContinueInbox({ dir });
  assert.equal(inbox.pending('c1'), null);
  await assert.rejects(inbox.target.check({ harness: 'nonsense', cwd: folder }), (e: any) => e.code === 'harness_not_configured');
  await assert.rejects(inbox.target.check({ harness: 'claude', cwd: path.join(folder, 'missing') }), (e: any) => e.code !== undefined);
  for (const harness of ['claude', 'codex', 'acp:gemini']) assert.ok(await inbox.target.check({ harness, cwd: folder }));
  const { nativeId } = await inbox.target.open({ chatId: 'c1', harness: 'claude', cwd: folder, handoff: 'the record' });
  assert.equal(inbox.pending('c1'), null, "not this Mac's yet");
  inbox.target.serve({ chatId: 'c1', nativeId });
  inbox.target.serve({ chatId: 'c2', nativeId: 'ffffffffffffffffffffffff' });
  assert.deepEqual(inbox.pending('c1'), { harness: 'claude', cwd: folder, text: 'the record' });
  assert.equal(inbox.pending('c2'), null);
  // a handoff file without its agent or folder waits for nothing a session could start from, and one from before chats were named is not listed
  fs.writeFileSync(path.join(dir, 'bound', 'old.json'), JSON.stringify({ handoff: 'no chat named' }));
  assert.equal(createContinueInbox({ dir }).pending('c1')?.text, 'the record');
  const restarted = createContinueInbox({ dir });
  assert.deepEqual(restarted.pending('c1'), { harness: 'claude', cwd: folder, text: 'the record' });
  restarted.done('c1');
  assert.equal(restarted.pending('c1'), null);
  assert.equal(createContinueInbox({ dir }).pending('c1'), null);
  await restarted.target.discard(nativeId);
});

test('an inbox entry without its agent or folder is no continue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-inbox-bad-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-inbox-bad-folder-'));
  const inbox = createContinueInbox({ dir });
  const { nativeId } = await inbox.target.open({ chatId: 'c1', harness: 'claude', cwd: folder, handoff: 'the record' });
  inbox.target.serve({ chatId: 'c1', nativeId });
  const file = path.join(dir, 'bound', fs.readdirSync(path.join(dir, 'bound')).find((n) => n !== 'old.json')!);
  fs.writeFileSync(file, JSON.stringify({ handoff: 'x', chatId: 'c1' }));
  assert.equal(inbox.pending('c1'), null);
});

test('the lazy inbox reads userData only when first used, and is one inbox from then on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-inbox-lazy-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-inbox-lazy-folder-'));
  let asked = 0;
  const inbox = createLazyContinueInbox({ getPath: () => (asked++, dir) }, 'host-inbox');
  assert.equal(asked, 0);
  assert.equal(inbox.pending('c1'), null);
  const { nativeId } = await inbox.target.open({ chatId: 'c1', harness: 'claude', cwd: folder, handoff: 'the record' });
  inbox.target.serve({ chatId: 'c1', nativeId });
  assert.equal(inbox.pending('c1')?.text, 'the record');
  inbox.done('c1');
  assert.equal(inbox.pending('c1'), null);
  assert.equal(asked, 1);
  assert.ok(fs.existsSync(path.join(dir, 'host-inbox')));
});
