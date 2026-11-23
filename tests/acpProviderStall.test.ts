// A provider failure under an ACP harness (#1534): opencode retries a failing provider in silence and says why only on
// stderr (--print-logs); the host reads it through the quirk's providerError, shows it on the running prompt, keeps
// it for the turn's end and the request ledger, and attributes it to the right chat only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptFixture } from './support/transcript-fixture.ts';
import { acpFixtureStop } from './support/acp-fixture-stop.mjs';

const require = createRequire(import.meta.url);
const acp = require('../electron/harness/acp.cjs');
const { ItemsLog } = require('../electron/platform/chats.cjs');
const pty = require('../electron/platform/pty.cjs');
const { lineReader, opencodeStreamError, watchProviderErrors, promptingChat } = require('../electron/harness/acp/providerErrors.cjs');
const opencode = require('../electron/harness/quirks/opencode.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-acp-stall-')));
const fixture = transcriptFixture(dir);
after(() => fixture.cleanup());

function setup(providerError: unknown = opencode.providerError) {
  const items = fixture.own(new ItemsLog(path.join(dir, `threads-${Math.random().toString(36).slice(2)}`)));
  const events: any[] = [];
  const host = new acp.AcpHost({
    items,
    quirks: (id: string) =>
      id === 'fake'
        ? {
            label: 'Fake',
            args: [AGENT],
            env: { FAKE_ACP_LOG: path.join(dir, 'agent.jsonl'), FAKE_ACP_STATE: path.join(dir, 'state') },
            providerError,
          }
        : null,
    ids: ['fake'],
    resolveBin: () => process.execPath,
    env: () => process.env,
    pty,
    cwd: dir,
    cancelRetryMs: 50,
    cancelForceMs: 2000,
  });
  fixture.stopWith(acpFixtureStop(host));
  host.on('event', (e: any) => events.push(e));
  return { host, events, items };
}
const until = async (fn: () => any, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const text = (t: string) => ({ cwd: dir, blocks: [{ type: 'text', text: t }], display: [{ type: 'text', text: t, text_elements: [] }] });

test('a provider that fails in silence: the running prompt shows its error, once, and the Stop that follows keeps it', async () => {
  const { host, events, items } = setup();
  const key = 'acp:fake:stall';
  const { turnId } = await host.send(key, text('PROVIDERFAIL'), { uuid: 'p1' });
  const shown = await until(() => events.find((e) => e.kind === 'providerError'));
  assert.deepEqual(shown, { key, kind: 'providerError', turnId, error: 'Rate limit exceeded' });
  // the title helper's failure (small=true) says nothing new
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.filter((e) => e.kind === 'providerError').length, 1);
  // nothing else came: no update, no end, exactly the silence the bench saw
  assert.equal(events.filter((e) => e.kind === 'update' && e.turnId === turnId).length, 0);
  assert.equal(
    events.some((e) => e.kind === 'turnEnd'),
    false,
  );
  host.cancel(key);
  const end = await until(() => events.find((e) => e.kind === 'turnEnd'));
  assert.equal(end.stopReason, 'cancelled');
  assert.equal(end.error, null);
  assert.equal(end.providerError, 'Rate limit exceeded');
  // the transcript's end carries it, so a replay shows why the turn stopped
  const rec = (await items.readAsync(key)).find((r: any) => r.t === 'end');
  assert.equal(rec.providerError, 'Rate limit exceeded');
});

test('a harness without a providerError quirk shows nothing from its stderr', async () => {
  const { host, events } = setup(null);
  const key = 'acp:fake:plain';
  await host.send(key, text('PROVIDERFAIL'), { uuid: 'p2' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    events.some((e) => e.kind === 'providerError'),
    false,
  );
  host.cancel(key);
  const end = await until(() => events.find((e) => e.kind === 'turnEnd'));
  assert.equal(end.providerError, undefined);
});

test('finish: a prompt that fails with no error of its own takes the provider error; one with its own keeps it', () => {
  const { host, events } = setup();
  const chat: any = { key: 'acp:fake:x', prompting: null };
  host.chats.set(chat.key, chat);
  chat.prompting = { turnId: 't1', providerError: 'Rate limit exceeded' };
  host.finish(chat, null, null);
  assert.equal(events.at(-1).error, 'Rate limit exceeded');
  assert.equal(events.at(-1).providerError, 'Rate limit exceeded');
  chat.prompting = { turnId: 't2', providerError: 'Rate limit exceeded' };
  host.finish(chat, null, 'Internal error: overloaded');
  assert.equal(events.at(-1).error, 'Internal error: overloaded');
  // a failure with neither its own error nor a provider error has none
  chat.prompting = { turnId: 't0' };
  host.finish(chat, null, null);
  assert.equal(events.at(-1).error, null);
  assert.equal(events.at(-1).providerError, undefined);
  // a prompt that ends well after a provider error recovered: no error on it
  chat.prompting = { turnId: 't3', providerError: 'Rate limit exceeded' };
  host.finish(chat, 'end_turn', null);
  assert.equal(events.at(-1).error, null);
  assert.equal(events.at(-1).providerError, undefined);
});

test('opencodeStreamError reads the main agent’s stream error, in the provider’s words', () => {
  const line = (rest: string) => `timestamp=2026-10-18T21:57:49Z level=ERROR run=1 message="stream error" providerID=opencode ${rest}`;
  assert.deepEqual(
    opencodeStreamError(line('session.id=ses_1 small=false agent=build error.error="AI_APICallError: Rate limit exceeded"')),
    {
      sessionId: 'ses_1',
      text: 'Rate limit exceeded',
    },
  );
  assert.equal(opencodeStreamError(line('session.id=ses_1 small=true agent=title error.error="AI_RetryError: Failed"')), null);
  // other spellings of the error field, an escaped quote, a bare value, and no session
  assert.deepEqual(opencodeStreamError(line('error.message="ProviderHeaderTimeoutError: no \\"headers\\" in 300s"')), {
    sessionId: null,
    text: 'no "headers" in 300s',
  });
  assert.deepEqual(opencodeStreamError(line('session.id=s2 error=Overloaded')), { sessionId: 's2', text: 'Overloaded' });
  // a bare error name is kept rather than emptied
  assert.deepEqual(opencodeStreamError(line('error="ProviderHeaderTimeoutError: "')), {
    sessionId: null,
    text: 'ProviderHeaderTimeoutError:',
  });
  assert.equal(opencodeStreamError(line('error.error="  "')), null);
  assert.equal(opencodeStreamError(line('session.id=s3')), null);
  assert.equal(opencodeStreamError('level=WARN message="duplicate skill name" name=pdf'), null);
  assert.equal(opencodeStreamError(undefined as any), null);
});

test('opencode runs with its errors on stderr, and its quirk reads them', () => {
  assert.deepEqual(opencode.args, ['acp', '--print-logs', '--log-level', 'ERROR']);
  assert.equal(opencode.providerError, opencodeStreamError);
});

test('lineReader joins lines split across chunks, skips blank ones, and drops a line that never ends', () => {
  const seen: string[] = [];
  const read = lineReader((l: string) => seen.push(l));
  read('one\r\ntw');
  read('o\n\n  \nthr');
  assert.deepEqual(seen, ['one', 'two']);
  read('x'.repeat(9000));
  read('\nfour\n');
  assert.deepEqual(seen, ['one', 'two', 'four']);
  // the rest of a line cut for its length is dropped with it, not read as a line of its own
  read('y'.repeat(9000));
  read('zz');
  read('z message="stream error"\nfive\n');
  // a whole line that long, in one chunk, is read cut short
  read(`${'w'.repeat(9000)}\n`);
  assert.deepEqual(seen.slice(3), ['five', 'w'.repeat(8000)]);
});

test('watchProviderErrors: only a running prompt of that session, or the agent’s only running one, takes the error', () => {
  const agent = new EventEmitter();
  const other = new EventEmitter();
  const a: any = { key: 'acp:o:a', agent, prompting: { turnId: 'ta' } };
  const b: any = { key: 'acp:o:b', agent, prompting: null };
  const c: any = { key: 'acp:o:c', agent: other, prompting: { turnId: 'tc' } };
  const sessions = new Map([
    ['s-a', a],
    ['s-b', b],
  ]);
  const seen: any[] = [];
  const host = {
    chats: new Map([
      [a.key, a],
      [b.key, b],
      [c.key, c],
    ]),
    chatOf: (ag: object, id: string) => (ag === agent ? (sessions.get(id) ?? null) : null),
    emitEvent: (e: any) => seen.push(e),
  };
  watchProviderErrors(host, agent, (l: string) => {
    if (l === 'N') return { text: 7 } as any;
    if (l.startsWith('U ')) return { text: l.slice(2) };
    const m = /^E (\S+) ?(.*)$/.exec(l);
    return m ? { sessionId: m[1], text: m[2] } : null;
  });
  // a quirk without a reader: nothing listens
  watchProviderErrors(host, other, undefined);
  assert.equal(other.listenerCount('stderr'), 0);
  agent.emit('stderr', 'E s-a down\nE s-b idle\nnoise\nE s-x gone\nE s-a \n');
  assert.deepEqual(seen, [{ key: 'acp:o:a', kind: 'providerError', turnId: 'ta', error: 'down' }]);
  assert.equal(a.prompting.providerError, 'down');
  // no session named: the agent's only running prompt; a text that is no string is nothing
  agent.emit('stderr', 'N\nU unnamed\n');
  assert.deepEqual(seen.at(-1), { key: 'acp:o:a', kind: 'providerError', turnId: 'ta', error: 'unnamed' });
  // a prompt already stopped shows and charges nothing more
  a.prompting.cancelled = true;
  agent.emit('stderr', 'E s-a later\n');
  assert.equal(seen.length, 2);
  // two running: nobody
  assert.equal(promptingChat(host, agent, null), a);
  b.prompting = { turnId: 'tb' };
  assert.equal(promptingChat(host, agent, null), null);
});

test('the request ledger records each provider error as a retry line, with the session and model it ran on', () => {
  const { AcpLedgerTap } = require('../electron/ledger/acpTap.cjs');
  const lines: any[] = [];
  const tap = new AcpLedgerTap({ record: (r: any) => lines.push(r), chatOf: (k: string) => `chat-of-${k}` });
  tap.event({
    key: 'acp:opencode:c1',
    kind: 'session',
    sessionId: 'ses_1',
    configOptions: [{ category: 'model', currentValue: 'opencode/beam-free' }],
  });
  tap.event({ key: 'acp:opencode:c1', kind: 'providerError', turnId: 'at-1', error: 'Rate limit exceeded' });
  // before the session is known: the chat's own id stands for it
  tap.event({ key: 'acp:opencode:c2', kind: 'providerError', turnId: 'at-2', error: 'Overloaded' });
  assert.deepEqual(lines, [
    {
      harness: 'opencode',
      chat: 'chat-of-acp:opencode:c1',
      session: 'ses_1',
      turn: 'at-1',
      account: { id: 'opencode' },
      req: 'opencode/beam-free',
      outcome: 'retry',
      code: 'provider_error',
      error: 'Rate limit exceeded',
    },
    {
      harness: 'opencode',
      chat: 'chat-of-acp:opencode:c2',
      session: 'c2',
      turn: 'at-2',
      account: { id: 'opencode' },
      req: undefined,
      outcome: 'retry',
      code: 'provider_error',
      error: 'Overloaded',
    },
  ]);
});

test('acpStop: a turn stopped while its provider kept failing says why; a rate limit reads as the limit it is', async () => {
  const { acpStop, PROVIDER_NEXT_STEP } = await import('../shared/acpStop.mjs');
  assert.deepEqual(acpStop('cancelled', null, ' Overloaded '), {
    status: 'interrupted',
    error: null,
    note: { kind: 'provider', text: `Stopped while the provider kept failing (Overloaded). ${PROVIDER_NEXT_STEP}` },
  });
  assert.equal(acpStop('cancelled', null, 'Rate limit exceeded').note?.kind, 'limit');
  assert.deepEqual(acpStop('cancelled', null), { status: 'interrupted', error: null, note: null });
});
