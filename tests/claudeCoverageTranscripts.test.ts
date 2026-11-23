// electron/harness/claude/index.cjs and transcripts: which other apps run a session, following a transcript another app
// writes, reading cwd, settings, goals and checkpoints from it, search, and the remaining IPC handlers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fakes, load, fakeBin, flush, until, home, tmp, lastQuery } from './support/electron-claude.ts';
import { checkpointsOf } from './support/checkpoints-of.ts';

const bin = fakeBin('transcripts/claude');
const projects = path.join(home, '.claude', 'projects', 'proj');
fs.mkdirSync(projects, { recursive: true });
const file = (sid: string) => path.join(projects, `${sid}.jsonl`);
const write = (sid: string, text: string) => fs.writeFileSync(file(sid), text);
const rows = (...r: any[]) => r.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n';
const unreadable = (sid: string) => {
  write(sid, '{"cwd":"/x"}\n');
  fs.chmodSync(file(sid), 0);
};
const S = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;

test('failed initial reconciliation retires its exact watcher, releases the follow and permits a real retry', async () => {
  const made: any[] = [];
  const unwatched: string[] = [];
  let mode = 'fail';
  let t: ReturnType<typeof load>;
  const sid = S(0);
  t = load({
    hooks: {
      onWatch: () => {
        if (mode === 'replace') {
          mode = 'ok';
          t.call('claude:unwatch', sid);
          t.call('claude:watch', sid);
          throw new Error('retired registration failed');
        }
        if (mode === 'fail') throw new Error('initial reconcile failed');
        if (mode === 'retire') t.call('claude:unwatch', sid);
      },
      onUnwatch: (key: string) => unwatched.push(key),
    },
  });
  fakes.watch = () => {
    const w: any = new EventEmitter();
    w.closed = false;
    w.close = () => {
      w.closed = true;
    };
    made.push(w);
    return w;
  };
  write(sid, rows({ type: 'user', uuid: 'external', message: { content: 'hi' } }));
  try {
    assert.equal(await t.call('claude:watch', sid), false);
    assert.equal(made[0].closed, true);
    assert.deepEqual(unwatched, [`claude:${sid}`]);
    mode = 'ok';
    assert.equal(await t.call('claude:watch', sid), true);
    assert.equal(made[1].closed, false);
    await t.call('claude:unwatch', sid);
    mode = 'replace';
    assert.equal(await t.call('claude:watch', sid), false);
    assert.equal(await new Promise((r) => setTimeout(() => r(made[2].closed), 30)), true, 'the hook-asked watch is made after its lookup');
    assert.equal(made[3].closed, false, 'old failure cannot close the replacement');
    await t.call('claude:unwatch', sid);
    mode = 'retire';
    assert.equal(await t.call('claude:watch', sid), false);
    assert.equal(made[4].closed, true);
  } finally {
    fakes.watch = null;
    t.claude.closeAll();
  }
});

test('a crash without a result retains its own transcript across unwatch, while new external writes are recognized', async () => {
  const require = createRequire(import.meta.url);
  const { ExternalWrites } = require('../electron/session/contract/reconcile.cjs');
  const { SessionStore } = require('../electron/session/state.cjs');
  const { createTranscriptWatchers } = require('../electron/app/transcriptWatchers.cjs');
  const state = new SessionStore();
  const external = new ExternalWrites({ state });
  let watchers: any;
  const t = load({ hooks: { onWatch: (key: string, file: string) => watchers.reconcileClaude(key, file) } });
  watchers = createTranscriptWatchers({
    broadcast: () => {},
    claude: t.claude,
    live: { external, controller: { chatOf: (id: string) => id }, codex: null },
  });
  const sid = S(0);
  const key = `claude:${sid}`;
  write(sid, rows({ type: 'user', uuid: 'old', message: { content: 'old prompt' } }));
  fakes.onQuery = (q: any) => (q.reply = null);
  try {
    assert.equal(t.claude.ownWrites(key), false);
    await t.claude.send(key, { bin, sessionId: sid, resume: true }, { role: 'user', content: 'ours' }, undefined, { uuid: 'own-prompt' });
    const q = lastQuery();
    await until('the prompt', () => q.inputs.length === 1);
    fs.appendFileSync(
      file(sid),
      rows(
        { type: 'user', uuid: 'own-prompt', parentUuid: 'old', message: { content: 'ours' } },
        { type: 'assistant', uuid: 'own-tool', parentUuid: 'own-prompt', message: { stop_reason: 'tool_use', content: [] } },
      ),
    );
    q.push({ type: 'assistant', uuid: 'own-tool', message: { content: [] } });
    await until('the assistant record', () => t.events.some((e: any) => e.msg?.uuid === 'own-tool'));
    q.end(new Error('CLI crashed'));
    await until('the process exit', () => !t.claude.turnApi.isLive(key));
    assert.equal(t.claude.ownWrites(key), true);
    await t.call('claude:watch', sid);
    assert.equal(state.get(key).runningElsewhere, false);
    await t.call('claude:unwatch', sid);
    await t.call('claude:watch', sid);
    assert.equal(t.claude.ownWrites(key), true);
    assert.equal(state.get(key).runningElsewhere, false);
    fs.appendFileSync(
      file(sid),
      rows({ type: 'user', uuid: 'external', parentUuid: 'own-tool', message: { content: 'new external prompt' } }),
    );
    assert.equal(t.claude.ownWrites(key), false);
    await t.call('claude:unwatch', sid);
    await t.call('claude:watch', sid);
    assert.equal(state.get(key).runningElsewhere, true, 'initial reconcile completes before a subsequent snapshot');
    await t.claude.deleteSession(sid);
    assert.equal(t.claude.ownWrites(key), false);
  } finally {
    external.forget(key);
    t.claude.closeAll();
  }
});

test('checkpoints come from snapshots of user messages; fork keeps the whole turn a prompt starts', async () => {
  const t = load();
  const { forkPoint } = t.claude;
  assert.deepEqual(
    await checkpointsOf(
      rows(
        { type: 'user', uuid: 'u1' },
        { type: 'file-history-snapshot', messageId: 'u1' },
        { type: 'file-history-snapshot', messageId: 'u2', isSnapshotUpdate: true },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'file-history-snapshot', messageId: 'orphan' },
        { type: 'user' },
        '{"type":"user", broken',
        { type: 'assistant', uuid: 'a1' },
      ),
    ),
    { u1: null },
  );
  assert.deepEqual(await t.call('claude:checkpoints', 'no-such-session'), {});
  fs.mkdirSync(file('dir-session'), { recursive: true });
  assert.deepEqual(await t.call('claude:checkpoints', 'dir-session'), {});
  write(
    'cp',
    rows({ type: 'user', uuid: 'u1' }, { type: 'user', uuid: 'u2', parentUuid: 'x' }, { type: 'file-history-snapshot', messageId: 'u2' }),
  );
  assert.deepEqual(await t.call('claude:checkpoints', 'cp'), { u2: 'x' });

  const msgs = [
    { type: 'user', uuid: 'p1', message: { content: 'first' } },
    { type: 'assistant', uuid: 'a1' },
    { type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result' }] } },
    { type: 'user', isMeta: true, uuid: 'm1', message: { content: 'meta' } },
    { type: 'user', isSynthetic: true, uuid: 's1', message: { content: 'goal' } },
    { type: 'user', uuid: 'n1', message: { content: 42 } },
    { type: 'system' },
    { type: 'assistant', uuid: 'a2' },
    { type: 'user', uuid: 'p2', message: { content: [{ type: 'image' }] } },
    { type: 'assistant', uuid: 'a3' },
    {},
    { type: 'user', uuid: 'p3', message: { content: [null, { type: 'text', text: 'x' }] } },
  ];
  assert.equal(forkPoint(msgs, 'p1'), 'a2');
  assert.equal(forkPoint(msgs, 'p3'), 'p3');
  assert.equal(forkPoint(msgs, 'missing'), null);
  assert.equal(forkPoint(null, 'p1'), null);

  fakes.sdk.getSessionMessages = async () => msgs;
  assert.deepEqual(await t.call('claude:fork', 'sid', 'p2'), ['forked', 'sid', { upToMessageId: 'a3' }]);
  assert.deepEqual(await t.call('claude:fork', 'sid', 'gone'), ['forked', 'sid', undefined]);
  assert.deepEqual(await t.call('claude:fork', 'sid'), ['forked', 'sid', undefined]);
  assert.equal(String((await t.call('claude:turns', 'sid', null)).page).includes('h-p1'), true);
  assert.equal(await t.claude.messages('sid'), msgs);
});

test('a session’s cwd is the first cwd field, read past a large first message; unreadable or absent gives undefined', async () => {
  const t = load();
  const cwdOf = t.claude.turnApi.sessionCwd;
  assert.equal(await cwdOf('absent'), undefined);
  write('near', rows({ type: 'user', cwd: '/near "q"', message: {} }));
  assert.equal(await cwdOf('near'), '/near "q"');
  write('far', rows({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } }, { cwd: '/far' }));
  assert.equal(await cwdOf('far'), '/far');
  write('none', rows({ type: 'user' }));
  assert.equal(await cwdOf('none'), undefined);
  unreadable('locked');
  assert.equal(await cwdOf('locked'), undefined);
  fs.mkdirSync(file('folder'), { recursive: true });
  assert.equal(await cwdOf('folder'), undefined);

  fakes.sdk.listSessions = async (o: any) => [
    { sessionId: 'near', o },
    { sessionId: 'x', cwd: '/given' },
  ];
  const list = await t.call('claude:list');
  assert.deepEqual(
    list.map((s: any) => s.cwd),
    ['/near "q"', '/given'],
  );
  assert.deepEqual(list[0].o, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }, 'one listing, the later pages cut from it');
  assert.equal((await t.call('claude:list', { limit: 5, offset: 1 }))[0].sessionId, 'x');
});

test('search matches titles and prompts, then transcripts, bounded in count and time', async () => {
  const t = load();
  assert.deepEqual(await t.call('claude:search', '  ', 5), []);
  assert.deepEqual(await t.call('claude:search', undefined), []);
  write('s-body', rows({ type: 'user', cwd: '/body', message: { content: 'the "Needle" here' } }));
  unreadable('s-locked');
  const all: any[] = [
    { sessionId: 's-title', customTitle: 'A needle title', cwd: '/t' },
    { sessionId: 's-sum', summary: 'needle summary' },
    { sessionId: 's-none' },
    { sessionId: 's-locked' },
    { sessionId: 's-body' },
    { sessionId: 's-prompt', firstPrompt: 'NEEDLE prompt', cwd: '/p' },
  ];
  fakes.sdk.listSessions = async () => all.map((s) => ({ ...s }));
  const hits = await t.call('claude:search', ' "Needle" ', 30);
  assert.deepEqual(
    hits.map((s: any) => s.sessionId),
    ['s-body'],
  );
  const plain = await t.call('claude:search', 'needle');
  assert.deepEqual(
    plain.map((s: any) => [s.sessionId, s.cwd]),
    [
      ['s-title', '/t'],
      ['s-sum', undefined],
      ['s-body', '/body'],
      ['s-prompt', '/p'],
    ],
  );
  assert.deepEqual(
    (await t.call('claude:search', 'needle', 2)).map((s: any) => s.sessionId),
    ['s-title', 's-sum'],
  );

  // only the first 400 transcripts are read
  fakes.sdk.listSessions = async () => [...Array.from({ length: 400 }, (_, i) => ({ sessionId: `nothing-${i}` })), { sessionId: 's-body' }];
  assert.deepEqual(await t.call('claude:search', 'needle'), []);
  // and only for 2.5 seconds
  mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    const late = {
      sessionId: 'slow',
      get customTitle() {
        mock.timers.tick(3000);
        return '';
      },
    };
    fakes.sdk.listSessions = async () => [late, { sessionId: 's-body' }];
    assert.deepEqual(await t.call('claude:search', 'needle'), []);
  } finally {
    mock.timers.reset();
  }
});

test('the model and effort a session last ran with, and its goal records, from the end of the transcript', async () => {
  const t = load();
  assert.equal(await t.call('claude:sessionSettings', 'absent'), null);
  assert.equal(await t.claude.turnApi.goalStatus('absent'), null);
  write(
    'st',
    rows(
      { type: 'goal_status', n: 1 },
      { type: 'assistant', message: { model: 'claude-old' } },
      { type: 'assistant', message: { model: 'claude-opus' }, effort: 'high' },
      { type: 'assistant', message: { model: '<synthetic>' } },
      { type: 'assistant', message: { model: 42 } },
      { type: 'assistant', message: { model: '' } },
      { type: 'assistant', message: {} },
      '{"type":"assistant", broken',
      { type: 'goal_status', n: 2 },
    ),
  );
  assert.deepEqual(await t.call('claude:sessionSettings', 'st'), { model: 'claude-opus', effort: 'high' });
  assert.equal(await t.claude.turnApi.goalStatus('st'), '{"type":"goal_status","n":1}\n{"type":"goal_status","n":2}');
  write('st2', rows({ type: 'assistant', message: { model: 'm' } }, { type: 'user' }));
  assert.deepEqual(await t.call('claude:sessionSettings', 'st2'), { model: 'm', effort: null });
  write('st3', rows({ type: 'user' }));
  assert.equal(await t.call('claude:sessionSettings', 'st3'), null);
  // large transcripts: only the tail is read
  write(
    'big',
    rows(
      { type: 'assistant', message: { model: 'early' } },
      { type: 'goal_status', n: 0 },
      'x'.repeat(1200 * 1024),
      { type: 'assistant', message: { model: 'late' } },
      { type: 'goal_status', n: 9 },
    ),
  );
  assert.deepEqual(await t.call('claude:sessionSettings', 'big'), { model: 'late', effort: null });
  assert.equal(await t.claude.turnApi.goalStatus('big'), '{"type":"goal_status","n":9}');
  unreadable('locked2');
  assert.equal(await t.call('claude:sessionSettings', 'locked2'), null);
  assert.equal(await t.claude.turnApi.goalStatus('locked2'), null);
});

test('transcripts are found under the configured folder; a missing folder finds none', () => {
  const t = load();
  write('here', rows({}));
  assert.equal(t.claude.transcriptPath('here'), file('here'));
  assert.equal(t.claude.transcriptPath('nowhere'), null);
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'no-config');
  try {
    assert.equal(t.claude.transcriptPath('here'), null);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('following a transcript: another app’s writes refresh the view, Sage’s own do not; a failed watcher is let go', async () => {
  const watched: any[] = [];
  const unwatched: any[] = [];
  const t = load({ hooks: { onWatch: (...a: any[]) => watched.push(a), onUnwatch: (...a: any[]) => unwatched.push(a) } });
  const made: any[] = [];
  fakes.watch = (f: string, cb: () => void) => {
    const w: any = new EventEmitter();
    w.file = f;
    w.cb = cb;
    w.closed = false;
    w.close = () => (w.closed = true);
    made.push(w);
    return w;
  };
  try {
    assert.equal(await t.call('claude:watch', 'absent'), false);
    const sid = S(8);
    const key = `claude:${sid}`;
    write(sid, rows({ type: 'user', uuid: 'u0', message: { content: 'x' } }));
    assert.equal(await t.call('claude:watch', sid), true);
    assert.equal(await t.call('claude:watch', sid), true);
    assert.equal(made.length, 1);
    await flush();
    assert.deepEqual(watched, [[key, file(sid)]]);

    const transcriptEvents = () => t.events.filter((e: any) => e.key === key && e.kind === 'transcript').length;
    made[0].cb();
    made[0].cb();
    await until('a refresh', () => transcriptEvents() === 1);

    // Sage's own session is mid-turn: its writes reach the view through the stream
    fakes.onQuery = (q: any) => (q.reply = null);
    await t.claude.send(key, { bin, sessionId: sid, resume: true }, { role: 'user', content: 'hi' });
    made[0].cb();
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(transcriptEvents(), 1);
    await t.claude.turnApi.control(key, 'close');
    // idle: right after its result (tip not settled) and once settled on the tip it wrote, nothing is passed on
    fakes.onQuery = (q: any) =>
      (q.reply = (m: any) => {
        fs.appendFileSync(
          file(sid),
          rows(
            { type: 'user', uuid: m.uuid, parentUuid: 'u0', message: { content: 'hi' } },
            { type: 'assistant', uuid: `a-${m.uuid}`, parentUuid: m.uuid },
          ),
        );
        return [{ type: 'assistant', uuid: `a-${m.uuid}`, message: { content: [] } }, { type: 'result' }];
      });
    await t.claude.send(key, { bin, sessionId: sid, resume: true }, { role: 'user', content: 'hi' });
    await until('idle', () => !t.claude.ownBusy(key));
    made[0].cb();
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(transcriptEvents(), 1);
    made[0].cb();
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(transcriptEvents(), 1);
    // the process ends (an edit closes it at once) and the notice of its last write comes late: still its own
    await t.claude.turnApi.control(key, 'close');
    await until('ended', () => !t.claude.ownBusy(key) && t.claude.scheduled(key) === 0);
    await new Promise((r) => setTimeout(r, 50));
    made[0].cb();
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(transcriptEvents(), 1);
    // a turn the CLI starts itself (a background task's wake-up) is Sage's own too: its writes reach the view through the stream
    fakes.onQuery = (q: any) => (q.reply = null);
    await t.claude.send(key, { bin, sessionId: sid, resume: true }, { role: 'user', content: 'hi' });
    const live = lastQuery();
    live.push({ type: 'result', subtype: 'success' });
    await until('idle again', () => !t.claude.ownBusy(key));
    live.push({ type: 'assistant', uuid: 'woken', message: { content: [] } });
    await until('woken', () => t.claude.ownBusy(key));
    made[0].cb();
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(transcriptEvents(), 1);
    await t.claude.turnApi.control(key, 'close');
    await until('closed again', () => !t.claude.ownBusy(key));
    // another app appends: passed on
    fs.appendFileSync(file(sid), rows({ type: 'user', uuid: 'elsewhere', parentUuid: 'x', message: { content: 'x' } }));
    made[0].cb();
    await until('a second refresh', () => transcriptEvents() === 2);

    // an error on a watcher that was replaced does nothing; on the current one it unwatches
    await t.call('claude:unwatch', sid);
    assert.ok(made[0].closed);
    assert.equal(await t.call('claude:watch', sid), true);
    made[0].emit('error', new Error('old'));
    assert.equal(made[1].closed, false);
    made[1].emit('error', new Error('gone'));
    assert.ok(made[1].closed);
    assert.deepEqual(unwatched, [[key], [key]]);
    await t.call('claude:unwatch', 'never-watched');

    fakes.watch = () => {
      throw new Error('EMFILE');
    };
    assert.equal(await t.call('claude:watch', sid), false);
  } finally {
    fakes.watch = null;
  }
  // closeAll lets every watcher go
  const u = load();
  write(S(9), rows({}));
  assert.equal(await u.call('claude:watch', S(9)), true);
  u.claude.closeAll();
  assert.equal(await u.call('claude:watch', S(9)), true);
  u.claude.closeAll();
});

test('deleting a session (ChatDeletion) ends its CLI first; the info IPC goes to the SDK (rename: tests/claudeRenameIpc.test.ts)', async () => {
  const t = load();
  assert.deepEqual(await t.claude.deleteSession('gone'), ['deleted', 'gone']);
  await t.claude.send('claude:live', { bin, sessionId: 'live', ephemeral: true }, { role: 'user', content: 'hi' });
  const q = lastQuery();
  assert.deepEqual(await t.claude.deleteSession('live'), ['deleted', 'live']);
  assert.ok(q.closed);
  assert.equal(t.claude.turnApi.isLive('claude:live'), false);
  assert.deepEqual(await t.call('claude:info', 'a'), { id: 'a' });
});

test('account handlers manage logins through the installed CLI', async () => {
  const t = load();
  fakes.run = (_c: string, args: string[]) =>
    args[0] === 'auth' ? { stdout: JSON.stringify({ loggedIn: true, email: 'me@x.y', authMethod: 'claude.ai' }) } : { stdout: '' };
  assert.equal((await t.call('claude:accounts')).active, 'default');
  await t.call('claude:refreshAccounts', bin);
  assert.ok(fakes.runs.some((r: any) => r.cmd === bin && r.args.join(' ') === 'auth status --json'));
  await assert.rejects(t.call('claude:addAccount', path.join(tmp, 'nope')), /not installed/);
  const started = await t.call('claude:addAccount', bin);
  assert.ok(started.id);
  assert.ok(t.broadcasts.some(([ch]) => ch === 'claude:accounts'));
  assert.equal((await t.call('claude:cancelAccountLogin')).login, null);
  assert.deepEqual(await t.call('claude:reloginCommand', bin, 'default'), [bin, 'auth', 'login']);
  await t.call('claude:removeAccount', bin, 'missing');
  await assert.rejects(Promise.resolve().then(() => t.call('claude:setActiveAccount', 'missing')));
  assert.equal((await t.call('claude:setActiveAccount', 'default')).active, 'default');
  assert.equal((await t.call('claude:setAccountAutoSwitch', 0)).autoSwitch, false);
});

test('model settings and goal status accept separator whitespace and escaped record types', async () => {
  const t = load();
  const goal = String.raw`{"type":"goal\u005fstatus","n":3}`;
  write(
    'json-layout',
    rows(
      { type: 'assistant', message: { model: 'old' } },
      '{ "type" : "assistant", "message" : { "model" : "latest" }, "effort" : "high" }',
      goal,
    ),
  );
  assert.deepEqual(await t.call('claude:sessionSettings', 'json-layout'), { model: 'latest', effort: 'high' });
  assert.equal(await t.claude.turnApi.goalStatus('json-layout'), goal);
});

test('goal attachment rows with escaped type spelling survive the main-process filter', async () => {
  const t = load();
  const goal = String.raw`{"type":"attachment","attachment":{"type":"goal\u005fstatus","met":true}}`;
  write('escaped-goal-attachment', rows({ type: 'user' }, goal));
  assert.equal(await t.claude.turnApi.goalStatus('escaped-goal-attachment'), goal);
});

test('cwd lookup decodes field spelling while retaining bounded partial-record support', async () => {
  const t = load();
  write('cwd-json-layout', '{ "cwd" : "/project" }\n');
  assert.equal(await t.claude.turnApi.sessionCwd('cwd-json-layout'), '/project');
  write('cwd-json-escape', String.raw`{"c\u0077d":"/project","message":"` + 'x'.repeat(600_000) + '"}\n');
  assert.equal(await t.claude.turnApi.sessionCwd('cwd-json-escape'), '/project');
});

test('initial reconciliation starts during watch registration; retired callbacks cannot restart it', async () => {
  const watched: any[] = [];
  const t = load({ hooks: { onWatch: (...a: any[]) => watched.push(a) } });
  const made: any[] = [];
  fakes.watch = (_f: string, cb: () => void) => {
    const w: any = new EventEmitter();
    w.cb = cb;
    w.close = () => {};
    made.push(w);
    return w;
  };
  try {
    const sid = S(9);
    write(sid, rows({ type: 'user', uuid: 'external', message: { content: 'hi' } }));
    assert.equal(await t.call('claude:watch', sid), true);
    await t.call('claude:unwatch', sid);
    await flush();
    assert.equal(watched.length, 1);
    assert.equal(await t.call('claude:watch', sid), true);
    await flush();
    assert.equal(watched.length, 2);
    made[0].cb();
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(
      t.events.some((e: any) => e.key === `claude:${sid}` && e.kind === 'transcript'),
      false,
    );
    await t.call('claude:unwatch', sid);
    fakes.watch = () => {
      throw new Error('EMFILE');
    };
    assert.equal(await t.call('claude:watch', sid), false);
    await flush();
    assert.equal(watched.length, 2);
  } finally {
    fakes.watch = null;
  }
});
