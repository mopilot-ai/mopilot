// A delayed Codex turn/start acknowledgment may consume only the note generation actually sent by that request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios';
import { tick } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { CodexConnection } = require('../electron/harness/codexConnection.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
function fixture(hasTools = false) {
  const backends: ReturnType<typeof deferred>[] = [];
  let ready = false;
  let serial = 0;
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/unused/mcp',
    socketPath: '/unused/socket',
    harnessPid: () => 1,
    hasTools: () => hasTools,
    nativeEnabled: () => true,
    nativeSurfaces: () => ({ chrome: true, computer: false, chromeRoute: 'backend' }),
    visibleTools: () => ['browser_navigate'],
    chromeNote: () => (ready ? 'OWN CHROME READY' : null),
    chromePending: () => !ready,
    degradedNote: () => (ready ? null : 'OWN CHROME STARTING'),
    browserBackends: {
      available: () => true,
      has: () => false,
      unloaded() {},
      exited() {},
      loaded() {
        const wait = deferred();
        backends.push(wait);
        return wait.promise;
      },
    },
  });
  const load = () => {
    ready = false;
    const id = ++serial;
    inj.outgoing({ id, method: 'thread/resume', params: { threadId: 'thread' } });
    inj.observe({ id, result: { thread: { id: 'thread' } } });
  };
  const answers: ReturnType<typeof deferred>[] = [];
  const sent: any[] = [];
  const connection = {
    down: false,
    tools: inj,
    initialize: async () => {},
    nativeLifecycle: { turnEnded: async () => {}, resetContext: () => null },
    // the adapter's threads with no recorded message yet (CodexAdapter.unrecorded)
    unrecorded: new Set<string>(),
    call(_method: string, params: any) {
      sent.push(params);
      const wait = deferred();
      answers.push(wait);
      return wait.promise;
    },
  };
  load();
  return {
    inj,
    sent,
    answers,
    load,
    request: () => CodexConnection.prototype.request.call(connection, 'turn/start', { threadId: 'thread', input: [] }),
    settle: async () => {
      ready = true;
      backends.at(-1)!.resolve(undefined);
      await tick();
    },
  };
}

test('backend settlement before a delayed turn/start acknowledgment preserves the corrected ready note', async () => {
  for (const hasTools of [false, true]) {
    const f = fixture(hasTools);
    const request = f.request();
    await tick();
    assert.match(JSON.stringify(f.sent[0].additionalContext), /starting|STARTING/);
    await f.settle();
    assert.match(f.inj.turnContext('thread').context.value, /OWN CHROME READY/);
    f.answers[0].resolve({});
    await request;
    assert.match(f.inj.turnContext('thread')?.context.value ?? '', /OWN CHROME READY/);
  }
});

test('an old acknowledgment cannot consume a replacement, compacted or restarted load note', async () => {
  for (const retire of ['reload', 'compact', 'exit'] as const) {
    const f = fixture();
    await f.settle();
    const request = f.request();
    await tick();
    if (retire === 'compact') f.inj.observe({ method: 'thread/compacted', params: { threadId: 'thread' } });
    else {
      if (retire === 'exit') f.inj.exited();
      else f.inj.observe({ method: 'thread/closed', params: { threadId: 'thread' } });
      f.load();
      await f.settle();
    }
    f.answers[0].resolve({});
    await request;
    assert.ok(f.inj.turnContext('thread'), retire);
  }
});

test('a failed request keeps its note; an unchanged successful acknowledgment consumes only its sent generation', async () => {
  const f = fixture();
  await f.settle();
  const failed = f.request();
  await tick();
  f.answers[0].reject(new Error('turn refused'));
  await assert.rejects(failed, /turn refused/);
  assert.ok(f.inj.turnContext('thread'));
  const success = f.request();
  await tick();
  f.answers[1].resolve({});
  await success;
  assert.equal(f.inj.turnContext('thread'), null);
});

test('receipt ownership rejects missing, foreign and retired generations, including before any acknowledgment', () => {
  const { ContextNotes } = require('../electron/capabilities/channels/contextNotes.cjs');
  const notes = new ContextNotes();
  notes.acknowledge('thread', undefined);
  assert.equal(notes.size, 0);
  const old = notes.capture('thread');
  assert.equal(notes.capture('thread'), old);
  notes.acknowledge('thread', {});
  notes.acknowledge('other', old);
  assert.equal(notes.size, 0);
  assert.equal(notes.delete('thread'), false);
  const current = notes.capture('thread');
  assert.notEqual(current, old);
  notes.acknowledge('thread', old);
  assert.equal(notes.size, 0);
  notes.acknowledge('thread', current);
  assert.equal(notes.has('thread'), true);
  assert.equal(notes.delete('thread'), true);
  const cleared = notes.capture('thread');
  notes.acknowledge('other', notes.capture('other'));
  notes.clear();
  assert.equal(notes.size, 0);
  notes.acknowledge('thread', cleared);
  assert.equal(notes.size, 0);
});

test('a loaded injection rejects acknowledgments with no captured receipt or the wrong note key', async () => {
  const f = fixture();
  await f.settle();
  const note = f.inj.turnContext('thread');
  f.inj.contextForwarded('thread', note.key);
  f.inj.contextForwarded('thread', 'other', f.inj.contextReceipt('thread'));
  f.inj.contextForwarded('unknown', note.key, f.inj.contextReceipt('unknown'));
  assert.ok(f.inj.turnContext('thread'));
  assert.equal(f.inj.noted.has('unknown'), false);
});
