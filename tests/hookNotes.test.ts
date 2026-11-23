// electron/session/hookNotes.cjs (#2066): a Codex hook run that failed, was blocked or cancelled stays in its chat across a
// reload, including one from before the first turn (turnId null), which the thread's next turn then leads with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { withChatNotes } from '../shared/chatNotes.mjs';

const require = createRequire(import.meta.url);
const { HookNotes } = require('../electron/session/hookNotes.cjs');

const run = (id: string, status: string, text = 'lint found 3 problems') => ({
  id,
  eventName: 'Stop',
  status,
  entries: [{ kind: 'error', text }],
});

function setup({ refuse = false } = {}) {
  const records = new Map<string, any>([['chat-1', { meta: {} }]]);
  const changed: string[] = [];
  const notes = new HookNotes({
    chats: {
      record: (id: string) => records.get(id),
      patchMeta: (id: string, patch: object) => {
        if (refuse) return false;
        const rec = records.get(id);
        rec.meta = { ...rec.meta, ...patch };
        return true;
      },
    },
    // as the controller's chatOf: a key it doesn't know answers with itself
    chatOf: (threadId: string) => (threadId === 'th-1' ? 'chat-1' : threadId),
    changed: (id: string) => changed.push(id),
    now: () => 5_000,
  });
  const saved = () => records.get('chat-1')?.meta.notes ?? [];
  return { notes, records, changed, saved };
}
const hook = (p: object) => ({ method: 'hook/completed', params: { threadId: 'th-1', ...p } });
const started = (threadId: string, id: string) => ({ method: 'turn/started', params: { threadId, turn: { id } } });

test('a failed run in a turn is saved once under that turn; a successful or unknown-thread one is not', () => {
  const { notes, changed, saved } = setup();
  notes.observe(hook({ turnId: 'T1', run: run('ok', 'completed') }));
  notes.observe(hook({ turnId: 'T1', run: run('r1', 'failed') }));
  // the app-server replays a run after a reconnect: still one line
  notes.observe(hook({ turnId: 'T1', run: run('r1', 'failed') }));
  notes.observe(hook({ threadId: 'unknown', turnId: 'T1', run: run('r2', 'failed') }));
  notes.observe(hook({ threadId: undefined, turnId: 'T1', run: run('r3', 'failed') }));
  notes.observe({ method: 'hook/completed' });
  notes.observe(undefined as any);
  assert.deepEqual(saved(), [
    { id: 'hook-r1', kind: 'hook', text: 'lint found 3 problems', turnId: 'T1', turn: Number.MAX_SAFE_INTEGER, at: 5_000 },
  ]);
  assert.deepEqual(changed, ['chat-1']);
});

test('a run before any turn (SessionStart) is saved at once, then led by the next turn of its own thread only', () => {
  const { notes, changed, saved } = setup();
  notes.observe(hook({ turnId: null, run: run('s1', 'blocked', '') }));
  assert.deepEqual(saved(), [
    {
      id: 'hook-s1',
      kind: 'hook',
      text: 'A hook blocked this action.',
      turnId: null,
      turn: Number.MAX_SAFE_INTEGER,
      at: 5_000,
      lead: true,
    },
  ]);
  // another thread's turn, or a turn/started without a turn id, takes nothing
  notes.observe(started('th-2', 'X'));
  notes.observe({ method: 'turn/started', params: { threadId: 'th-1' } });
  assert.equal(saved()[0].turnId, null);
  notes.observe(started('th-1', 'T1'));
  assert.equal(saved()[0].turnId, 'T1');
  // the turn after that takes nothing more
  notes.observe(started('th-1', 'T2'));
  assert.equal(saved()[0].turnId, 'T1');
  assert.deepEqual(changed, ['chat-1', 'chat-1']);
});

test('the next turn moves only notes still waiting: one removed or the chat gone meanwhile is left alone', () => {
  const { notes, records, changed, saved } = setup();
  notes.observe(hook({ turnId: null, run: run('s1', 'failed') }));
  // the chat's notes are gone meanwhile (none left at all)
  records.get('chat-1').meta = {};
  notes.observe(started('th-1', 'T1'));
  assert.deepEqual(saved(), []);
  // between turns again, so the next turnless run waits; then the chat itself is gone
  notes.observe({ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'T1' } } });
  notes.observe(hook({ turnId: null, run: run('s2', 'failed') }));
  assert.equal(saved()[0].turnId, null);
  records.delete('chat-1');
  assert.doesNotThrow(() => notes.observe(started('th-1', 'T1')));
  assert.deepEqual(changed, ['chat-1', 'chat-1']);
});

test('a run with no turn id while a turn runs leads that turn; once it completes, the next one takes it', () => {
  const { notes, saved } = setup();
  notes.observe(started('th-1', 'T1'));
  notes.observe(hook({ turnId: null, run: run('s1', 'failed') }));
  assert.deepEqual([saved()[0].turnId, saved()[0].lead], ['T1', true]);
  // another turn's completion leaves T1 running; its own ends it
  notes.observe({ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'T0' } } });
  notes.observe(hook({ turnId: null, run: run('s2', 'failed') }));
  assert.equal(saved()[1].turnId, 'T1');
  notes.observe({ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'T1' } } });
  notes.observe({ method: 'turn/completed', params: {} });
  notes.observe(hook({ turnId: null, run: run('s3', 'failed') }));
  assert.equal(saved()[2].turnId, null);
  notes.observe(started('th-1', 'T2'));
  assert.deepEqual(
    saved().map((n: any) => n.turnId),
    ['T1', 'T1', 'T2'],
  );
});

test("a chat file that can't be written says nothing changed and keeps nothing waiting", () => {
  const { notes, changed, saved } = setup({ refuse: true });
  notes.observe(hook({ turnId: null, run: run('s1', 'failed') }));
  notes.observe(started('th-1', 'T1'));
  assert.deepEqual([saved(), changed], [[], []]);
});

test('reloaded Codex history (thread/read has no hook runs) shows the saved lines where they ran', () => {
  const { notes, saved } = setup();
  notes.observe(hook({ turnId: null, run: run('s1', 'failed', 'SessionStart: config missing') }));
  notes.observe(started('th-1', 'T1'));
  notes.observe(hook({ turnId: 'T1', run: run('r1', 'failed') }));
  const read = [
    { id: 'T0', startedAt: 1, items: [{ id: 'u0' }] },
    { id: 'T1', startedAt: 6, items: [{ id: 'u1' }, { id: 'a1' }] },
  ];
  const shown = withChatNotes(read, saved());
  assert.deepEqual(
    shown.map((t) => t.items.map((i: any) => (i.type === 'hookPrompt' ? `hook:${i.fragments[0].text}` : i.id))),
    [['u0'], ['hook:SessionStart: config missing', 'u1', 'a1', 'hook:lint found 3 problems']],
  );
  // still live, the turn's own item is shown and the saved copy is not added again
  const live = [{ id: 'T1', items: [{ id: 'u1' }, { id: 'hook-r1', type: 'hookPrompt' }] }];
  assert.deepEqual(
    withChatNotes(live, saved().slice(1)).map((t) => t.items.map((i) => i.id)),
    [['u1', 'hook-r1']],
  );
});

test("a run before the first turn shows at the chat's end until a turn takes it, and nowhere in a chat with no turns", () => {
  const { notes, saved } = setup();
  notes.observe(hook({ turnId: null, run: run('s1', 'failed') }));
  const turns = [
    { id: 'T0', startedAt: 1, items: [{ id: 'u0' }] },
    { id: 'T1', startedAt: 2, items: [{ id: 'u1' }] },
  ];
  assert.deepEqual(
    withChatNotes(turns, saved()).map((t) => t.items.map((i) => i.id)),
    [['u0'], ['u1', 'hook-s1']],
  );
  assert.deepEqual(withChatNotes([], saved()), []);
});

test("main's harness taps keep the line with no window open and tell every window; a store that throws costs nothing", async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { openHarnessTaps } = require('../electron/app/harnessTaps.cjs');
  const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');
  clearIgnored();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-taps-'));
  try {
    const rec: any = { meta: {} };
    let broken = false;
    const chats = {
      record: (id: string) => (id === 'chat-1' ? rec : undefined),
      get: (id: string) => ({ id, notes: rec.meta.notes }),
      patchMeta: (_id: string, patch: object) => {
        if (broken) throw new Error('disk full');
        return (rec.meta = { ...rec.meta, ...patch }), true;
      },
    };
    const sent: any[] = [];
    const taps = openHarnessTaps({
      app: { getPath: () => dir },
      readState: () => ({ prefs: {} }),
      claude: { observe: () => {}, ledgerAccount: () => null, turnApi: { control: async () => null } },
      live: { chats },
      broadcastAll: (channel: string, payload: any) => sent.push([channel, payload.id, payload.chat.notes.length]),
      chatOf: (id: string) => (id === 'th-1' ? 'chat-1' : id),
    });
    taps.ledger.codex.message = () => {};
    taps.context.service.codexMessage = () => {};
    taps.codexMessage(hook({ turnId: null, run: run('s1', 'failed') }));
    assert.deepEqual(sent, [['chats:changed', 'chat-1', 1]]);
    broken = true;
    assert.doesNotThrow(() => taps.codexMessage(hook({ turnId: 'T1', run: run('r1', 'failed') })));
    assert.ok(recentIgnored().some((e: any) => /hook/.test(JSON.stringify(e))));
    taps.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
