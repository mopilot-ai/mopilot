// The Remote Run milestone steps of the Host acceptance run (scripts/host-accept/milestones): the command line, the skip result, the step lists and every step, against a stand-in Host that keeps cards, pauses and answers as the real one does on the wire (W: a step that fails, A: the two answers at once, B: the command line, I: the stand-in's Host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, parseArgs, runSteps } from '../scripts/host-accept.mjs';
import { MILESTONES, isMilestone, milestoneSteps } from '../scripts/host-accept/milestones/index.mjs';
import { WIRING, cheapestOf } from '../scripts/host-accept/milestones/harness.mjs';
import { killApp } from '../scripts/host-accept/milestones/common.mjs';

let phoneExit = 0;

type Opts = {
  appRuns?: boolean;
  replaceHost?: boolean;
  dropCard?: boolean;
  loser?: 'mac' | 'phone';
  failedInRecord?: boolean;
  noEpoch?: boolean;
  badReason?: boolean;
  replay?: boolean;
  harness?: { id: string; detected?: boolean; signedIn?: boolean; models?: any[] } | null;
  scratchFails?: boolean;
  badStop?: string;
  noCard?: 'end' | 'error';
  cardKind?: string;
};

/** A Host as a client sees it: connections that subscribe to chats, cards that wait, a clock that pauses, tools that go to the client that drives. */
function fakeHost(o: Opts = {}) {
  const s = {
    pid: '1000',
    killed: [] as string[],
    commands: [] as string[],
    cards: new Map<string, any>(),
    attention: [] as any[],
    answered: new Set<string>(),
    first: '',
    starts: [] as any[],
    sends: [] as any[],
  };
  const conns: any[] = [];
  let pendingCalls = 0;
  const emit = (chatId: string, item: object) =>
    conns
      .filter((c) => c.subs.has(chatId))
      .forEach((c) => setImmediate(() => c.push(`${JSON.stringify({ event: 'frame', chatId, frame: { item } })}\n`)));
  const finish = (chatId: string, requestId: string) => {
    s.cards.delete(chatId);
    emit(chatId, { t: 'event', event: { kind: 'permissionCancelled', requestId, reason: 'answered' } });
    emit(chatId, { t: 'event', event: { kind: 'turnEnd', stopReason: 'end_turn' } });
    emit(chatId, { t: 'assistant', text: 'fake-acp: done', stopReason: 'end_turn' });
    if (o.failedInRecord) emit(chatId, { t: 'event', event: { kind: 'toolCallUpdate', status: 'failed' } });
  };
  const m = {
    state: s,
    async run(command: string) {
      s.commands.push(command);
      const out = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      if (command === 'echo $HOME') return out('/home/u\n');
      if (command.includes('git init')) return o.scratchFails ? { code: 1, stdout: '', stderr: 'no git\n' } : out('');
      if (command.includes('[m]opilot-host.mjs serve')) return out(s.pid);
      if (command.includes('[M]oPilot.app')) return out(o.appRuns ? '4321\n' : '');
      if (command.startsWith('kill -9')) return s.killed.push(command), o.replaceHost && (s.pid = '1001'), out('');
      return out('');
    },
    open() {
      const conn: any = { subs: new Set<string>(), tools: false, push: (_: string) => undefined, end: () => undefined };
      conns.push(conn);
      const reply = (id: number, body: object) => setImmediate(() => conn.push(`${JSON.stringify({ id, ...body })}\n`));
      return {
        write(line: string) {
          const { id, method, params } = JSON.parse(line);
          if (method === 'status') return reply(id, { result: { harnesses: o.harness ? [o.harness] : [] } });
          if (method === 'host.hello') return reply(id, { result: { agreed: true } });
          if (method === 'host.toolsSync') return (conn.tools = true), reply(id, { result: {} });
          if (method === 'host.pending')
            return reply(id, { result: { cards: o.dropCard && pendingCalls++ > 0 ? [] : [...s.cards.values()], attention: s.attention } });
          if (method === 'chat.subscribe') {
            conn.subs.add(params.chatId);
            // a subscribe from revision 0 replays the record: here an empty assistant item of the turn that was paused
            if (o.replay) emit(params.chatId, { t: 'assistant', text: '', stopReason: 'end_turn' });
            // the clock runs out for a chat that waits when a client reads it again
            if (s.cards.has(params.chatId) && s.attention.length === 0 && params.chatId === s.first) {
              const { requestId } = s.cards.get(params.chatId);
              s.cards.delete(params.chatId);
              s.attention.push({ chatId: params.chatId, kind: 'paused', since: 1, reason: o.badReason ? 'other' : 'approval_timeout' });
              emit(params.chatId, { t: 'event', event: { kind: 'permissionCancelled', requestId, reason: 'expired' } });
            }
            return reply(id, { result: {} });
          }
          if (method === 'chat.send') {
            s.attention = s.attention.filter((a) => a.chatId !== params.chatId);
            s.sends.push(params);
            if (o.harness) emit(params.chatId, { t: 'event', event: { kind: 'turnEnd', stopReason: o.badStop ?? 'end_turn' } });
            else emit(params.chatId, { t: 'assistant', text: `fake-acp: ${params.text}`, stopReason: 'end_turn' });
            return reply(id, { result: { turnId: 't2' } });
          }
          if (method === 'chat.start') {
            s.starts.push(params);
            if (/^(PERMIT leave|Create the file|Run exactly)/.test(params.text)) s.first = params.chatId;
            if (
              !o.noCard &&
              (params.text.startsWith('PERMIT') || params.text.startsWith('Create the file') || params.text.startsWith('Run exactly'))
            )
              s.cards.set(params.chatId, {
                chatId: params.chatId,
                epoch: 1,
                requestId: `r-${params.chatId}`,
                family: 'acp',
                cardKind: o.cardKind ?? 'permission',
                summary: { tool: 'edit', line: 'Fake action' },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow' },
                  { optionId: 'reject', name: 'Reject', kind: 'deny' },
                ],
                at: 1,
              });
            if (params.text.startsWith('MCPTOOL'))
              setImmediate(() =>
                conn.push(
                  `${JSON.stringify({ event: 'tool', chatId: params.chatId, ...(o.noEpoch ? {} : { epoch: 1 }), callId: 'call1', name: 'accept_echo' })}\n`,
                ),
              );
            if (o.noCard)
              emit(
                params.chatId,
                o.noCard === 'end'
                  ? { t: 'event', event: { kind: 'turnEnd', stopReason: 'refusal' } }
                  : { t: 'error', message: 'Invalid sessionId' },
              );
            return reply(id, { result: { turnId: 't1' } });
          }
          if (method === 'host.toolResult') {
            reply(id, { result: { accepted: true } });
            return emit(params.chatId, { t: 'assistant', text: 'fake-acp: tool ok', stopReason: 'end_turn' });
          }
          if (method === 'chat.answer') {
            const key = `${params.chatId}/${params.requestId}`;
            const losing = o.loser && params.key.endsWith(`-${o.loser}`);
            if (s.answered.has(key) || losing) return reply(id, { error: 'Someone already answered this.', code: 'card_answered' });
            s.answered.add(key);
            finish(params.chatId, params.requestId);
            return reply(id, { result: { answered: true } });
          }
          return reply(id, { error: `unexpected ${method}` });
        },
        onData: (fn: (c: string) => void) => (conn.push = fn),
        kill: () => conn.end(),
        closed: new Promise<void>((r) => (conn.end = r)),
      };
    },
  };
  return m;
}

const ctxFor = (m: any, opts: Partial<{ waitPauseMin: number; harness: string }> = {}) => ({
  m,
  deps: { authenticate: async () => undefined, helloParams: () => ({}), phoneCheck: () => phoneExit },
  state: { socket: '/s', identity: {}, dataDir: '/d', pid: '1000' },
  nonce: 'n',
  opts: { waitPauseMin: 0, harness: '', ...opts },
});

const byId = (id: string) => [...MILESTONES.M1, ...MILESTONES.M2, ...MILESTONES.M5].find((s) => s.id === id)!;
const rowsOf = (ctx: any, ids: string[]) => runSteps({ steps: ids.map(byId) as any, ctx });

test('B: --milestone, and --wait-pause are read; anything else is refused', () => {
  const base = ['--vm', 'mopilot-work'];
  assert.deepEqual(parseArgs(base), {
    vm: 'mopilot-work',
    ssh: '',
    sshArgs: [],
    keep: false,
    only: [],
    out: '',
    milestone: '',

    waitPauseMin: 0,
    harness: '',
    appRepo: '',
    awayMin: 0,
    matrix: false,
    runs: 5,
    cell: [],
    trace: '',
    stopDelayMs: 0,
    cloud: '',
    secrets: '',
    dry: false,
  });
  assert.deepEqual([parseArgs(base).milestone, parseArgs(base).waitPauseMin], ['', 0]);
  const o = parseArgs([...base, '--milestone', 'M2', '--wait-pause', '31']);
  assert.deepEqual([o.milestone, o.waitPauseMin], ['M2', 31]);
  assert.throws(() => parseArgs([...base, '--milestone', 'M9']), /--milestone takes one of M1, M2, M4, M5, M6/);
  assert.equal(parseArgs([...base, '--milestone', 'M1', '--harness', 'codex']).harness, 'codex');
  assert.throws(() => parseArgs([...base, '--milestone', 'M1', '--harness', 'gemini']), /--harness takes claude or codex/);
  assert.throws(() => parseArgs([...base, '--harness', 'claude']), /--harness belongs to --milestone M1/);
  assert.throws(() => parseArgs([...base, '--wait-pause', 'soon']), /number of minutes/);
  assert.throws(() => parseArgs([...base, '--wait-pause', '-1']), /number of minutes/);
  const app = parseArgs([...base, '--milestone', 'M5', '--app-repo', '~/mopilot', '--away', '5']);
  assert.deepEqual([app.appRepo, app.awayMin], ['~/mopilot', 5]);
  assert.throws(() => parseArgs([...base, '--app-repo', '~/mopilot']), /belong to --milestone M5/);
  assert.throws(() => parseArgs([...base, '--milestone', 'M1', '--away', '2']), /belong to --milestone M5/);
  assert.throws(() => parseArgs([...base, '--milestone', 'M5', '--app-repo', 'a; rm -rf /']), /plain path/);
  assert.throws(() => parseArgs([...base, '--milestone', 'M5', '--away', 'later']), /number of minutes/);
  assert.ok(isMilestone('M5') && !isMilestone('M7') && !isMilestone('toString'));
});

test('B: a milestone run is the required setup, then the milestone’s own steps in order', () => {
  const ids = (m: 'M1' | 'M2' | 'M5') =>
    milestoneSteps(m)
      .map((s) => s.id)
      .join(' ');
  assert.equal(ids('M1'), 'A1 A2 A3 A5 A6 S1a S1b S2');
  assert.equal(ids('M2'), 'A1 A2 A3 A5 A6 S3a S3b S3c S4');
  assert.equal(ids('M5'), 'A1 A2 A3 A5 A6 S11 S11b');
  assert.ok(
    milestoneSteps('M5')
      .slice(0, 5)
      .every((s) => s.fatal),
  );
});

test('A: a step that returns a gap is a SKIP with its text, and the run still passes', async () => {
  const rows = await runSteps({
    steps: [
      { id: 'X1', title: 'gap', run: async () => ({ skip: 'GAP: nothing to shorten' }) },
      { id: 'X2', title: 'ok', run: async () => 'fine' },
    ],
    ctx: {},
  });
  assert.deepEqual(
    rows.map((r) => [r.status, r.detail]),
    [
      ['SKIP', 'GAP: nothing to shorten'],
      ['PASS', 'fine'],
    ],
  );
});

test('B: a milestone run on a machine that cannot run the Host fails at the first step and skips the milestone’s steps', async () => {
  const out: string[] = [];
  const m = {
    run: async () => ({ code: 1, stdout: '', stderr: 'no node' }),
    open: () => {
      throw new Error('unused');
    },
  };
  const code = await main(['--vm', 'mopilot-work', '--milestone', 'M5'], {
    out: (t) => out.push(t),
    deps: (() => ({})) as any,
    channelFor: () => m as any,
  });
  assert.equal(code, 1);
  assert.match(out[0], /\| A1 .*\| FAIL \|/);
  assert.match(out[0], /\| S11 .*\| SKIP \|.*an earlier required step failed/);
});

test('A: the app’s process is killed with SIGKILL when there is one, and its absence is said', async () => {
  const machine = fakeHost({ appRuns: true });
  assert.match(await killApp(ctxFor(machine)), /app process 4321 killed with SIGKILL/);
  assert.ok(machine.state.commands.includes('kill -9 4321'));
  assert.match(await killApp(ctxFor(fakeHost())), /no app process runs on the machine/);
});

test('I: M1/S1: the card survives the app, expires with the reason, and a message resumes the run', { timeout: 60_000 }, async () => {
  const ctx = ctxFor(fakeHost({ appRuns: true }), { waitPauseMin: 0.01 });
  const rows = await rowsOf(ctx, ['S1a', 'S1b']);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['PASS', 'PASS'],
    JSON.stringify(rows),
  );
  assert.match(rows[0].detail, /app process 4321 killed.*stayed up and still lists the card/);
  assert.match(rows[1].detail, /paused \(approval_timeout\).*expired.*resumed/);
});

test('W: S1b and S2 wait for the reply after their action, not for a replayed empty assistant item', { timeout: 60_000 }, async () => {
  const ctx = ctxFor(fakeHost({ appRuns: true, replay: true }), { waitPauseMin: 0.01 });
  const rows = await rowsOf(ctx, ['S1a', 'S1b', 'S2']);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['PASS', 'PASS', 'PASS'],
    JSON.stringify(rows),
  );
});

test('A: without --wait-pause the expiry is reported as a gap, never a pass', async () => {
  const ctx = ctxFor(fakeHost());
  const rows = await rowsOf(ctx, ['S1a', 'S1b']);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['PASS', 'SKIP'],
  );
  assert.match(rows[1].detail, /GAP: the Host exposes no card-timeout setting/);
});

test('W: S1 fails with why: no card to leave, a Host replaced by the kill, a card lost, another pause reason', async () => {
  assert.match((await rowsOf(ctxFor(fakeHost()), ['S1b']))[0].detail, /S1a did not leave a waiting card/);
  const replaced = (await rowsOf(ctxFor(fakeHost({ appRuns: true, replaceHost: true })), ['S1a']))[0];
  assert.equal(replaced.status, 'FAIL');
  assert.match(replaced.detail, /The Host was replaced/);
  const lost = (await rowsOf(ctxFor(fakeHost({ dropCard: true })), ['S1a']))[0];
  assert.match(lost.detail, /card is gone from host.pending/);
  const reason = await rowsOf(ctxFor(fakeHost({ badReason: true }), { waitPauseMin: 0.01 }), ['S1a', 'S1b']);
  assert.match(reason[1].detail, /not approval_timeout/);
});

test('I: M1/S2: the tool call goes to the driving client and the watcher only watches', async () => {
  const row = (await rowsOf(ctxFor(fakeHost()), ['S2']))[0];
  assert.equal(row.status, 'PASS', row.detail);
  assert.match(row.detail, /call call1 went to the driving client/);
  const bare = (await rowsOf(ctxFor(fakeHost({ noEpoch: true })), ['S2']))[0];
  assert.equal(bare.status, 'PASS', bare.detail);
});

test('I: M5/S11: the turn outlives the killed app and nothing reads as interrupted', async () => {
  const row = (await rowsOf(ctxFor(fakeHost({ appRuns: true })), ['S11']))[0];
  assert.equal(row.status, 'PASS', row.detail);
  assert.match(row.detail, /app process 4321 killed.*Host 1000 stayed up.*end_turn/);
  const replaced = (await rowsOf(ctxFor(fakeHost({ replaceHost: true, appRuns: true })), ['S11']))[0];
  assert.match(replaced.detail, /The Host was replaced/);
});

test('I: M2/S3: Allow and Deny from the fake phone finish the turn, and the relay path is the P6 check', async () => {
  phoneExit = 0;
  const rows = await rowsOf(ctxFor(fakeHost()), ['S3a', 'S3b', 'S3c']);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['PASS', 'PASS', 'PASS'],
    JSON.stringify(rows),
  );
  assert.match(rows[0].detail, /P6 phone check passed.*APNs/);
  assert.match(rows[1].detail, /chose Allow.*no longer waits/);
  assert.match(rows[2].detail, /does not name a failed call/);
  phoneExit = 2;
  assert.match((await rowsOf(ctxFor(fakeHost()), ['S3a']))[0].detail, /exited 2/);
  phoneExit = 0;
  const quiet = await rowsOf(ctxFor(fakeHost({ failedInRecord: true })), ['S3c']);
  assert.match(quiet[0].detail, /shows the tool call as failed/);
});

test('A: S4: two answers at the same moment leave one winner, whichever client it is', async () => {
  const first = (await rowsOf(ctxFor(fakeHost()), ['S4']))[0];
  assert.equal(first.status, 'PASS', first.detail);
  assert.match(first.detail, /Mac was first/);
  const phone = (await rowsOf(ctxFor(fakeHost({ loser: 'mac' })), ['S4']))[0];
  assert.match(phone.detail, /phone was first/);
});

const haiku = { id: 'claude-haiku-5-5', name: 'Haiku 5.5', efforts: ['low', 'high'] };

test('I: M1/S1 on Claude: the cheapest model at low effort, in a scratch repo, ask-for-approval, then resumed', {
  timeout: 60_000,
}, async () => {
  const m = fakeHost({
    appRuns: true,
    harness: { id: 'claude', detected: true, signedIn: true, models: [{ id: 'claude-opus-5', name: 'Opus', efforts: ['high'] }, haiku] },
  });
  const rows = await rowsOf(ctxFor(m, { waitPauseMin: 0.01, harness: 'claude' }), ['S1a', 'S1b']);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['PASS', 'PASS'],
    JSON.stringify(rows),
  );
  assert.match(rows[0].detail, /claude \(claude-haiku-5-5, low\)/);
  const start = m.state.starts[0];
  assert.deepEqual(
    [
      start.harness,
      start.permission,
      start.model,
      start.effort,
      start.cwd,
      /^claude:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(start.chatId),
    ],
    ['claude', 'default', 'claude-haiku-5-5', 'low', start.cwd, true],
  );
  assert.match(start.cwd, /^\/home\/u\/mopilot-accept-/);
  assert.match(start.text, /note\.txt/);
  assert.deepEqual([m.state.sends[0].model, m.state.sends[0].effort], ['claude-haiku-5-5', 'low']);
  assert.ok(m.state.commands.some((c: string) => c.startsWith('rm -rf ') && c.includes('mopilot-accept-')));
});

test('I: M1/S1 on Codex: its small model; an effort it lists, or none', { timeout: 60_000 }, async () => {
  const run = async (efforts?: string[]) => {
    const m = fakeHost({
      appRuns: true,
      harness: { id: 'codex', detected: true, signedIn: true, models: [{ id: 'gpt-5-mini', name: 'GPT mini', efforts }] },
    });
    const rows = await rowsOf(ctxFor(m, { waitPauseMin: 0.01, harness: 'codex' }), ['S1a', 'S1b']);
    assert.deepEqual(
      rows.map((r) => r.status),
      ['PASS', 'PASS'],
      JSON.stringify(rows),
    );
    return m.state.starts[0];
  };
  assert.equal((await run(['medium', 'high'])).effort, 'medium');
  // Codex's Ask for approval lets a write inside the folder through, so its prompt writes beside it
  const codexStart = (await run(['low'])) as { text: string; cwd: string };
  assert.equal(
    codexStart.text,
    `Run exactly this shell command and nothing else, and do not pick another path: touch '${codexStart.cwd}-outside.txt'`,
  );
  const none = await run();
  assert.ok(!('effort' in none) && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(none.chatId));
});

test('A: a harness that is signed out, absent or lists no model skips both S1 steps and never signs in', async () => {
  const cases: [Opts['harness'], RegExp][] = [
    [{ id: 'claude', detected: true, signedIn: false }, /claude is signed out.*never signs in/],
    [null, /claude is not installed.*not listed/],
    [{ id: 'claude', detected: true, signedIn: true }, /lists no model to run on/],
  ];
  for (const [harness, why] of cases) {
    const rows = await rowsOf(ctxFor(fakeHost({ harness }), { harness: 'claude' }), ['S1a', 'S1b']);
    assert.deepEqual(
      rows.map((r) => r.status),
      ['SKIP', 'SKIP'],
    );
    assert.match(rows[0].detail, why);
    assert.match(rows[1].detail, /S1a was skipped/);
  }
});

test('W: the scratch repo is removed when S1 fails, or is skipped for want of a clock; a failed repo or a bad stop is said', {
  timeout: 60_000,
}, async () => {
  const real = { id: 'claude', detected: true, signedIn: true, models: [haiku] };
  const failedRepo = fakeHost({ harness: real, scratchFails: true });
  const [a] = await rowsOf(ctxFor(failedRepo, { harness: 'claude' }), ['S1a']);
  assert.equal(a.status, 'FAIL');
  assert.match(a.detail, /scratch git repo could not be made: no git/);
  const noCard = fakeHost({ harness: real, dropCard: true });
  const [lost] = await rowsOf(ctxFor(noCard, { harness: 'claude' }), ['S1a']);
  assert.equal(lost.status, 'FAIL');
  assert.ok(noCard.state.commands.some((c: string) => c.startsWith('rm -rf ')));
  const noClock = fakeHost({ harness: real });
  const rows = await rowsOf(ctxFor(noClock, { harness: 'claude' }), ['S1a', 'S1b']);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['PASS', 'SKIP'],
  );
  assert.ok(noClock.state.commands.some((c: string) => c.startsWith('rm -rf ')));
  const bad = fakeHost({ appRuns: true, harness: real, badStop: 'cancelled' });
  const after = await rowsOf(ctxFor(bad, { waitPauseMin: 0.01, harness: 'claude' }), ['S1a', 'S1b']);
  assert.match(after[1].detail, /resumed turn ended with cancelled/);
  assert.ok(bad.state.commands.some((c: string) => c.startsWith('rm -rf ')));
});

test('A: each harness reads its resumed turn: the fake agent by its text, the real ones by how the turn ended', () => {
  const said = (text: string, stopReason: string) => ({ frame: { item: { text, stopReason } } });
  const ended = (stopReason: string) => ({ frame: { item: { event: { stopReason } } } });
  assert.equal(WIRING.fake.resumed(said('fake-acp: resume please', 'end_turn')), '');
  assert.match(WIRING.fake.resumed(said('', 'end_turn')), /said ""/);
  assert.equal(WIRING.codex.resumed(ended('end_turn')), '');
  assert.match(WIRING.codex.resumed(ended('cancelled')), /ended with cancelled/);
  assert.match(WIRING.claude.resumed(ended('refusal')), /ended with refusal/);
});

test('W: a chat that ends or fails without a card is said at once, not after the wait', async () => {
  for (const noCard of ['end', 'error'] as const) {
    const started = Date.now();
    const [a] = await rowsOf(ctxFor(fakeHost({ noCard })), ['S1a']);
    assert.equal(a.status, 'FAIL');
    assert.match(a.detail, /ended without raising a card.*(refusal|Invalid sessionId)/);
    assert.ok(Date.now() - started < 10_000);
  }
});

test('A: the cheapest model: the first pattern that names a model, then the lowest list price, else the oldest generation', () => {
  const ids = (...x: string[]) => x.map((id) => ({ id }));
  const pick = (re: RegExp[], models: { id: string }[]) => cheapestOf(re, models)?.id;
  assert.equal(pick([/haiku/], ids('claude-sonnet-4-5', 'claude-haiku-4-5')), 'claude-haiku-4-5');
  assert.equal(pick([], ids('claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-5')), 'claude-haiku-4-5');
  const codex = ids('gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6.1-terra');
  // both lunas are priced (gpt-6-luna $0.10/$0.50, gpt-5.6-luna $0.20/$1.20), so the lower list price wins over the older generation
  assert.equal(pick(WIRING.codex.cheap, codex), 'gpt-6-luna');
  assert.equal(pick([/none/], ids('gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5-sol')), 'gpt-5-sol');
  assert.equal(pick([/luna/], ids('gpt-5.6-luna', 'gpt-luna', 'gpt-5-luna')), 'gpt-luna');
  assert.equal(pick([], []), undefined);
});

test('W: a card of another kind than the harness table expects is said, and the outside file goes with the scratch repo', {
  timeout: 60_000,
}, async () => {
  const m = fakeHost({
    harness: { id: 'codex', detected: true, signedIn: true, models: [{ id: 'gpt-5-mini', name: 'GPT mini', efforts: ['low'] }] },
    cardKind: 'question',
  });
  const [row] = await rowsOf(ctxFor(m, { harness: 'codex' }), ['S1a']);
  assert.equal(row.status, 'FAIL');
  assert.match(row.detail, /The card is a question card, not permission/);
  assert.ok(m.state.commands.some((c: string) => /^rm -rf '.*mopilot-accept-.*' '.*-outside\.txt'$/.test(c)));
});
