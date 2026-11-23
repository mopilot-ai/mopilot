// `host-accept --matrix` (scripts/host-accept/matrix): the journey on each harness, the six-chat block and the timings, against a stand-in machine and Host that keep a record per chat and replay it to a client that subscribes from revision 0, as the real one does (W: a step that fails, I: the stand-in, B: the command line, A: the arithmetic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, parseArgs, runSteps } from '../scripts/host-accept.mjs';
import { finishMatrix, matrixSteps } from '../scripts/host-accept/matrix/index.mjs';
import { formatTimings } from '../scripts/host-accept/matrix/timings.mjs';
import { REPLY_WAIT, awaitReply, percentile, spread, textsOf } from '../scripts/host-accept/matrix/common.mjs';

type Opts = {
  /** the harnesses the machine reports as signed in */
  real?: ('claude' | 'codex')[];
  signedOut?: boolean;
  noModels?: boolean;
  /** what the stand-in Host gets wrong */
  silent?: boolean;
  badStop?: boolean;
  noEffect?: boolean;
  denyWrites?: boolean;
  noStop?: boolean;
  noReplay?: boolean;
  crosstalk?: boolean;
  sameCard?: boolean;
  noTool?: boolean;
  toolBroken?: boolean;
  stuck?: boolean;
  startFails?: boolean;
  subscribeFails?: 'all' | 'later';
  /** agents the machine lacks, and agents it has but is signed out of (J11); a send after the hand-back goes through (J9) */
  absent?: string[];
  outOf?: string[];
  staysAfterHandBack?: boolean;
  runsThroughContinue?: boolean;
  /** a Host that takes a continue for an agent it lacks or is signed out of (J11 must say so) */
  lenient?: boolean;
};

// a reply that never comes is found in a third of a second here, not ten
REPLY_WAIT.ms = 300;

const MODELS = {
  claude: [{ id: 'claude-haiku-5-5', name: 'Haiku', efforts: ['low'] }],
  codex: [{ id: 'gpt-5-mini', name: 'mini', efforts: ['low'] }],
};

/** A machine whose Host keeps a journal per chat, cards that wait, and files that a real harness's approved write leaves. */
function machine(o: Opts = {}) {
  const s = {
    files: new Set<string>(),
    journals: new Map<string, any[]>(),
    cards: new Map<string, any>(),
    commands: [] as string[],
    answers: new Set<string>(),
    effects: new Map<string, string>(),
    running: new Set<string>(),
    handoffs: new Map<string, string>(),
    handed: new Set<string>(),
  };
  const conns: any[] = [];
  const record = (chatId: string, item: object) => {
    const list = s.journals.get(chatId) ?? [];
    s.journals.set(chatId, list);
    list.push(item);
    for (const c of conns)
      if (c.subs.has(chatId)) setImmediate(() => c.push(`${JSON.stringify({ event: 'frame', chatId, frame: { item } })}\n`));
  };
  const end = (chatId: string, text: string, stopReason = 'end_turn') => {
    // as the Host records them: the turn's end first, its summary item a moment later
    record(chatId, { t: 'event', event: { kind: 'turnEnd', stopReason: o.badStop ? 'refusal' : stopReason } });
    setTimeout(() => record(chatId, { t: 'assistant', text: o.silent ? 'nothing' : text, stopReason }), 40);
  };
  /** the file a real harness's prompt asks for, and the other chats' markers a broken Host leaks */
  const effectOf = (text: string, cwd: string) =>
    /^Create the file (\S+) in/.exec(text)?.[1]?.replace(/^/, `${cwd}/`) ?? /touch '([^']+)'/.exec(text)?.[1];
  const handle = (method: string, p: any, conn: any): any => {
    if (method === 'status') {
      const harnesses = (o.real ?? []).map((id) => ({
        id,
        detected: true,
        signedIn: !o.signedOut,
        ...(o.noModels ? {} : { models: MODELS[id] }),
      }));
      for (const id of o.absent ?? []) harnesses.push({ id, detected: false, signedIn: false } as any);
      for (const id of o.outOf ?? []) harnesses.push({ id, detected: true, signedIn: false, signIn: [`${id} login`] } as any);
      return { result: { harnesses } };
    }
    if (method === 'host.hello' || method === 'host.toolsSync') return { result: { agreed: true } };
    if (method === 'chat.subscribe') {
      if (o.subscribeFails === 'all' || (o.subscribeFails === 'later' && conns.indexOf(conn) > 0))
        return { error: 'no subscribe', code: 'nope' };
      conn.subs.add(p.chatId);
      if (!o.noReplay)
        for (const item of s.journals.get(p.chatId) ?? [])
          setImmediate(() => conn.push(`${JSON.stringify({ event: 'frame', chatId: p.chatId, frame: { item } })}\n`));
      return { result: {} };
    }
    if (method === 'host.pending') return { result: { cards: [...s.cards.values()], attention: [] } };
    if (method === 'chat.stop') {
      if (!p.key) return { error: 'That request has no valid key.', code: 'invalid' };
      // a Stop that finds no running turn changes nothing
      if (s.running.has(p.chatId)) {
        s.running.delete(p.chatId);
        record(p.chatId, { t: 'event', event: { kind: 'turnEnd', stopReason: o.noStop ? 'end_turn' : 'cancelled' } });
      }
      return { result: { stopped: true } };
    }
    if (method === 'chat.prepareContinue') {
      const id = String(p.harness).replace(/^acp:/, '');
      if (o.lenient) return { result: { preparedId: 'prep1', epoch: p.epoch, cwd: p.cwd } };
      if ((o.absent ?? []).includes(id)) return { error: `${id} isn't installed on this machine.`, code: 'agent_missing' };
      if ((o.outOf ?? []).includes(id)) return { error: `Sign in to ${id} on this machine first.`, code: 'agent_signed_out' };
      s.handoffs.set(p.chatId, p.handoff);
      return { result: { preparedId: 'prep1', epoch: p.epoch, cwd: p.cwd } };
    }
    if (method === 'chat.commitContinue') {
      if (s.running.has(p.chatId) && !o.runsThroughContinue) return { error: 'Stop the running turn first.', code: 'turn_running' };
      if (s.running.has(p.chatId)) s.running.delete(p.chatId);
      s.handed.add(p.chatId);
      return { result: { epoch: p.expectedEpoch + 1 } };
    }
    if (method === 'chat.release') return { result: { released: 'finalized' } };
    if (method === 'chat.send') {
      if (s.handed.has(p.chatId) && !o.staysAfterHandBack) return { error: 'This chat was handed to another host.', code: 'chat_released' };
      const word = /secret word is (\S+?)\./.exec(s.handoffs.get(p.chatId) ?? '')?.[1];
      if (word && /secret word/.test(p.text)) {
        setTimeout(() => end(p.chatId, `fake: ${word}`), 5);
        return { result: { turnId: 't2' } };
      }
      const text = /exactly this text and nothing else: (\S+)/.exec(p.text)?.[1] ?? /^hello (\S+)/.exec(p.text)?.[1] ?? p.text;
      setTimeout(() => end(p.chatId, `fake: ${text}`), 5);
      return { result: { turnId: 't2' } };
    }
    if (method === 'host.toolResult') {
      if (!o.toolBroken) setTimeout(() => end(p.chatId, 'tool done'), 5);
      else setTimeout(() => end(p.chatId, 'tool done', 'refusal'), 5);
      return { result: { accepted: true } };
    }
    if (method === 'chat.start') {
      if (o.startFails) return { error: 'no start', code: 'nope' };
      const text: string = p.text;
      const marker = /(mk\w+x\d+)/.exec(text)?.[1] ?? '';
      if (/^(PERMIT|Create the file|Run exactly)/.test(text)) {
        const requestId = `r-${p.chatId}`;
        s.cards.set(p.chatId, {
          chatId: p.chatId,
          epoch: 1,
          requestId: o.sameCard ? 'r-shared' : requestId,
          family: 'acp',
          cardKind: 'permission',
          summary: { tool: 'edit', line: 'Fake action' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow' },
            { optionId: 'reject', name: 'Reject', kind: 'deny' },
          ],
          at: 1,
        });
        const effect = effectOf(text, p.cwd);
        if (effect) s.effects.set(p.chatId, effect);
        record(p.chatId, { t: 'user', text });
        return { result: { turnId: 't1' } };
      }
      if (text.startsWith('MCPTOOL') && !o.noTool)
        setImmediate(() =>
          conn.push(`${JSON.stringify({ event: 'tool', chatId: p.chatId, epoch: 1, callId: 'call1', name: 'accept_echo' })}\n`),
        );
      else if (/^(SLOW|Count from)/.test(text)) {
        // the user's message is journaled at once; the turn is running a moment later, and a Stop before that is counted but does nothing, as in the controller
        record(p.chatId, { t: 'user', text });
        setTimeout(() => (s.running.add(p.chatId), record(p.chatId, { t: 'event', event: { kind: 'turnStart' } })), 60);
        setTimeout(() => s.running.has(p.chatId) && end(p.chatId, 'counted to 300'), 400);
      } else if (/^(hello|Reply with)/.test(text)) setTimeout(() => end(p.chatId, o.stuck ? 'fake: other' : `fake: ${marker}`), 5);
      return { result: { turnId: 't1' } };
    }
    if (method === 'chat.answer') {
      const key = `${p.chatId}/${p.requestId}`;
      const card = s.cards.get(p.chatId);
      if (!card || s.answers.has(key)) return { error: 'answered', code: 'card_answered' };
      s.answers.add(key);
      s.cards.delete(p.chatId);
      const allow = p.optionId === 'allow';
      const effect = s.effects.get(p.chatId);
      if (effect && ((allow && !o.noEffect) || (!allow && o.denyWrites))) s.files.add(effect);
      const other = [...s.journals.keys()].find((k) => k !== p.chatId);
      setTimeout(() => {
        if (o.crosstalk && other)
          record(p.chatId, {
            t: 'assistant',
            text: `see ${/mk\w+x\d+/.exec(JSON.stringify(s.journals.get(other)))?.[0]}`,
            stopReason: null,
          });
        end(p.chatId, allow ? 'allowed' : 'denied');
      }, 5);
      return { result: { answered: true } };
    }
    return { error: `unexpected ${method}` };
  };
  return {
    state: s,
    async run(command: string) {
      s.commands.push(command);
      const out = (stdout = '', code = 0) => ({ code, stdout, stderr: '' });
      if (command === 'echo $HOME') return out('/home/u\n');
      if (command.startsWith('test -e')) return out('', s.files.has(/'([^']+)'/.exec(command)![1]) ? 0 : 1);
      if (command.includes('[m]opilot-host.mjs serve')) return out('1000');
      return out();
    },
    open() {
      const conn: any = { subs: new Set<string>(), push: (_: string) => undefined, end: () => undefined };
      conns.push(conn);
      return {
        write(line: string) {
          const { id, method, params } = JSON.parse(line);
          setImmediate(() => conn.push(`${JSON.stringify({ id, ...handle(method, params, conn) })}\n`));
        },
        onData: (fn: (c: string) => void) => (conn.push = fn),
        kill: () => conn.end(),
        closed: new Promise<void>((r) => (conn.end = r)),
      };
    },
  };
}

const ctxFor = (m: any, runs = 2) => ({
  m,
  deps: { authenticate: async () => undefined, helloParams: () => ({}) },
  state: { socket: '/s', identity: {}, dataDir: '/d', pid: '1000' } as Record<string, any>,
  nonce: 'n',
  opts: { waitPauseMin: 0, harness: '', runs, stopDelayMs: 0 },
});
const steps = matrixSteps().filter((s) => !s.fatal);
const rowsOf = (ctx: any, ids: string[]) => runSteps({ steps: ids.map((id) => steps.find((s) => s.id === id)!) as any, ctx });
const detail = async (o: Opts, id: string) => (await rowsOf(ctxFor(machine(o)), [id]))[0];
const both = { real: ['claude', 'codex'] } as Opts;

test('B: the matrix run is the setup, each harness’s journey, the six chats and the timings; it takes --runs and nothing else', () => {
  assert.deepEqual(
    matrixSteps().map((s) => s.id),
    [
      'A1',
      'A2',
      'A3',
      'A5',
      'A6',
      ...['fake', 'claude', 'codex'].flatMap((k) =>
        ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9', 'J10', 'J11'].map((j) => `${k}/${j}`),
      ),
      'multi/six',
      'timings',
    ],
  );
  const base = ['--vm', 'mopilot-work'];
  assert.deepEqual([parseArgs(base).matrix, parseArgs(base).runs], [false, 5]);
  assert.deepEqual(
    [parseArgs([...base, '--matrix', '--runs', '10']).matrix, parseArgs([...base, '--matrix', '--runs', '10']).runs],
    [true, 10],
  );
  assert.throws(() => parseArgs([...base, '--runs', '0']), /--runs takes a whole number/);
  assert.throws(() => parseArgs([...base, '--runs', 'x']), /--runs takes a whole number/);
  assert.throws(() => parseArgs([...base, '--matrix', '--milestone', 'M1']), /--matrix is a run of its own/);
  assert.throws(() => parseArgs([...base, '--matrix', '--only', 'A3']), /--matrix is a run of its own/);
});

test('A: percentiles are nearest-rank and the table says how many runs each number is from', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([7], 95), 7);
  assert.equal(spread([10, 20, 30]), 'p50 20 ms, p95 30 ms (n=3)');
  const table = formatTimings({ fake: { start: [10, 30], card: [5], resume: [8] } });
  assert.match(table, /\| fake \| start to first frame \| 2 \| 10 \| 30 \|/);
  assert.match(table, /\| fake \| card round trip \| 1 \| 5 \| 5 \|/);
  assert.match(table, /\| fake \| resume \(caught up\) \| 1 \| 8 \| 8 \|/);
});

test('I: with all three harnesses the whole journey, the six chats and the timings pass; a question and a harness switch are named as not covered', {
  timeout: 120_000,
}, async () => {
  const m = machine(both);
  const ctx = ctxFor(m);
  const rows = await rowsOf(
    ctx,
    steps.map((s) => s.id),
  );
  const bad = rows.filter((r) => r.status === 'FAIL');
  assert.deepEqual(bad, [], JSON.stringify(bad));
  assert.equal(rows.filter((r) => r.status === 'PASS').length, 3 * 8 + 2);
  const covered = rows.filter((r) => r.status === 'SKIP');
  assert.deepEqual(
    covered.map((r) => r.id),
    ['fake/J4', 'fake/J8', 'fake/J11', 'claude/J4', 'claude/J8', 'claude/J11', 'codex/J4', 'codex/J8', 'codex/J11'],
  );
  assert.ok(covered.filter((r) => !r.id.endsWith('/J11')).every((r) => /^NOT COVERED: /.test(r.detail)));
  assert.match(covered.find((r) => r.id === 'fake/J11')!.detail, /every agent on this Host is installed and signed in/);
  assert.match(covered.find((r) => r.id === 'claude/J11')!.detail, /shown once, on the fake key/);
  const six = rows.find((r) => r.id === 'multi/six')!;
  assert.match(six.detail, /6 chats at once \(fake, claude, codex, fake, claude, codex\)/);
  assert.match(ctx.state.timingsTable, /\| claude \| card round trip \| 2 \|/);
  assert.match(ctx.state.timingsTable, /\| codex \| resume \(caught up\) \| 2 \|/);
  // a real harness's chats ran in a scratch repo each, and the run's own files go at its end
  assert.equal(ctx.state.cleanups.length, 2);
  for (const fn of ctx.state.cleanups) await fn();
  assert.ok(m.state.commands.filter((c) => c.startsWith('rm -rf ')).length >= 2);
});

test('A: a harness that is signed out or lists no model skips its journey with the reason, and the fake agent still runs', {
  timeout: 60_000,
}, async () => {
  const rows = await rowsOf(ctxFor(machine({ real: ['claude'], signedOut: true })), ['claude/J1', 'fake/J1', 'claude/J3']);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['SKIP', 'PASS', 'SKIP'],
  );
  assert.match(rows[0].detail, /claude is signed out/);
  const none = await rowsOf(ctxFor(machine({ real: ['codex'], noModels: true })), ['codex/J2']);
  assert.match(none[0].detail, /lists no model/);
  const only = ctxFor(machine());
  const ran = await rowsOf(only, ['multi/six']);
  assert.match(ran[0].detail, /\(fake, fake, fake, fake, fake, fake\)/);
});

test('W: J1 to J3 fail with why: an unmarked reply, a bad stop, a tool that does not complete, a write that did not run or ran after Deny', {
  timeout: 120_000,
}, async () => {
  assert.match((await detail({ silent: true }, 'fake/J1')).detail, /No assistant item with .* reached the client/);
  assert.match((await detail({ badStop: true }, 'fake/J1')).detail, /turn ended with refusal/);
  assert.match((await detail({ toolBroken: true }, 'fake/J2')).detail, /turn ended with refusal/);
  assert.match((await detail({ ...both, noEffect: true }, 'claude/J2')).detail, /to exist/);
  assert.match((await detail({ ...both, denyWrites: true }, 'codex/J3')).detail, /to be absent/);
});

test('W: J9 to J11: the hand-back is refused after it, a running turn refuses a continue, a missing or signed-out agent is refused in words; each fails with why', {
  timeout: 60_000,
}, async () => {
  assert.match((await detail({ staysAfterHandBack: true }, 'fake/J9')).detail, /send after the hand-back was accepted/);
  assert.match((await detail({ runsThroughContinue: true }, 'fake/J10')).detail, /A continue during the turn was accepted/);
  const out = await detail({ absent: ['opencode'], outOf: ['kimi'] }, 'fake/J11');
  assert.equal(out.status, 'PASS');
  assert.match(out.detail, /opencode: agent_missing "opencode isn't installed on this machine\."; kimi: agent_signed_out "Sign in to kimi/);
  const only = await detail({ absent: ['opencode'] }, 'fake/J11');
  assert.match(only.detail, /^opencode: agent_missing/);
  // Claude Code and Codex are asked for by their own names, a basic agent as acp:<id>
  assert.match(
    (await detail({ absent: ['claude'], outOf: ['codex'] }, 'fake/J11')).detail,
    /^claude: agent_missing.*; codex: agent_signed_out/,
  );
  assert.match(
    (await detail({ lenient: true, absent: ['opencode'] }, 'fake/J11')).detail,
    /continue to opencode was accepted \(wanted agent_missing\)/,
  );
  const kinds = (await detail({ outOf: ['kimi'] }, 'fake/J11')).detail;
  assert.match(kinds, /kimi: agent_signed_out/);
});

test('W: J5 to J7 fail with why: a stop that does not cancel, a returning client with nothing, a second client with no history', {
  timeout: 120_000,
}, async () => {
  assert.match((await detail({ noStop: true }, 'fake/J5')).detail, /stopped turn ended with end_turn, \d+ ms after the Stop/);
  // a Stop that waits first (--stop-delay) is sent that much later
  const delayed = ctxFor(machine());
  delayed.opts.stopDelayMs = 60;
  const began = Date.now();
  assert.equal((await rowsOf(delayed, ['fake/J5']))[0].status, 'PASS');
  assert.ok(Date.now() - began >= 60);
  assert.match((await detail({ stuck: true }, 'fake/J6')).detail, /No assistant item with .* reached the client/);
  assert.match((await detail({ noReplay: true }, 'fake/J7')).detail, /Timed out waiting for the Host to say so/);
});

test('W: six chats fail with why: a record that carries another chat’s marker, one card for two chats', { timeout: 120_000 }, async () => {
  assert.match((await detail({ crosstalk: true }, 'multi/six')).detail, /carries fake's marker/);
  assert.match((await detail({ sameCard: true }, 'multi/six')).detail, /Two chats share a card request/);
});

test('I: main runs the matrix steps and ends with the timings table after the report', { timeout: 120_000 }, async () => {
  const out: string[] = [];
  const m = machine();
  const code = await main(['--vm', 'mopilot-work', '--matrix'], {
    out: (t: string) => out.push(t),
    deps: (() => ({ authenticate: async () => undefined, helloParams: () => ({}), agentFiles: () => [] })) as any,
    channelFor: (() => m) as any,
  });
  assert.equal(typeof code, 'number');
  assert.match(out.join('\n'), /Host acceptance run/);
});

test('W: a Host that refuses a start or a subscribe is the step’s failure, and the clients it opened are closed', {
  timeout: 60_000,
}, async () => {
  assert.match((await detail({ startFails: true }, 'fake/J1')).detail, /no start/);
  assert.match((await detail({ subscribeFails: 'all' }, 'fake/J1')).detail, /no subscribe/);
  // the second client of J6 (the one that returns) is refused its subscribe
  assert.match((await detail({ subscribeFails: 'later' }, 'fake/J6')).detail, /no subscribe/);
});

test('A: the assistant’s words are the assistant items only, whatever else the chat’s frames and events carry', () => {
  const c = {
    events: [
      { chatId: 'x', frame: { item: { t: 'assistant', text: 'one' } } },
      { chatId: 'x', frame: { item: { t: 'assistant' } } },
      { chatId: 'x', frame: { item: { t: 'user', text: 'prompt' } } },
      { chatId: 'x', event: 'tool' },
      { chatId: 'y', frame: { item: { t: 'assistant', text: 'other chat' } } },
    ],
  };
  assert.deepEqual(textsOf(c, 'x'), ['one', '']);
});

test('A: a run that is not a matrix ends with nothing added, one that got to the timings ends with the table, and cleanups run', async () => {
  const ran: string[] = [];
  assert.equal(await finishMatrix({ state: {} }), '');
  assert.equal(await finishMatrix({ state: { cleanups: [async () => void ran.push('a')], timingsTable: 'T' } }), '\nT');
  assert.deepEqual(ran, ['a']);
});

test('A: awaitReply matches only the chat’s assistant items that carry the marker, and any assistant item for an empty marker', async () => {
  const events = [
    { chatId: 'x', event: 'tool' },
    { chatId: 'x', frame: { item: { t: 'user', text: 'mk1' } } },
    { chatId: 'x', frame: { item: { t: 'assistant' } } },
    { chatId: 'y', frame: { item: { t: 'assistant', text: 'mk1' } } },
    { chatId: 'x', frame: { item: { t: 'assistant', text: 'says mk1' } } },
  ];
  const client = { events, waitFor: async (match: (e: any) => boolean) => events.find(match) };
  assert.equal(await awaitReply(client, 'x', 'mk1'), events[4]);
  assert.equal(await awaitReply(client, 'x', ''), events[2]);
  const failing = { events, waitFor: async () => Promise.reject(new Error('timeout')) };
  await assert.rejects(() => awaitReply(failing, 'x', 'mk9'), /No assistant item with mk9 reached the client/);
});
