// A window's copy of each chat's SessionState (src/store/session/useSession.ts) and of its capabilities
// (src/store/session/useCaps.ts), against a fake preload bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeExports } from './support/runtimeExports.ts';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: [string, any[]][] = [];
let snapshots: Record<string, any> = {};
let snapshotFails = false;
let patchResult: Promise<boolean> | boolean = true;
let capsResult: (chatId: string | null, hint: any) => Promise<any> = async () => null;
let onPatch: ((p: any) => void) | null = null;
let onCapsChanged: (() => void) | null = null;
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
installNativeStub({
  session: {
    snapshot: (id: string) => (
      calls.push(['snapshot', [id]]), snapshotFails ? Promise.reject(new Error('gone')) : Promise.resolve(snapshots[id] ?? null)
    ),
    onPatch: (cb: any) => (calls.push(['onPatch', []]), (onPatch = cb), () => {}),
    patch: (id: string, partial: any) => (calls.push(['patch', [id, partial]]), Promise.resolve(patchResult)),
    caps: (id: string | null, hint: any) => (calls.push(['caps', [id, hint]]), capsResult(id, hint)),
    onCapsChanged: (cb: any) => (calls.push(['onCapsChanged', []]), (onCapsChanged = cb), () => {}),
  },
});
const named = (n: string) => calls.filter(([c]) => c === n).map(([, a]) => a);
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const S = await import('../src/store/session/useSession.ts');
const C = await import('../src/store/session/useCaps.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

const snap = (rev: number, extra: any = {}) => ({ ...EMPTY_SESSION, rev, ...extra });
const reset = () => {
  calls.length = 0;
  snapshots = {};
  snapshotFails = false;
  patchResult = true;
  S.useSessions.setState({ sessions: {}, loaded: {} }, true);
};

test('an optimistic write does not make an unknown session loaded; a failed snapshot can be retried', async () => {
  reset();
  const pending = deferred<any>();
  snapshots.unknown = pending.promise;
  const write = S.setSession('unknown', { plan: true });
  assert.equal(S.useSessions.getState().loaded.unknown, undefined);
  pending.resolve(null);
  await write;
  await flush();
  assert.equal(S.useSessions.getState().loaded.unknown, undefined);
  snapshots.unknown = snap(0, { turn: 'running' });
  await S.refreshSession('unknown');
  assert.equal(S.useSessions.getState().loaded.unknown, true);
  assert.equal(S.sessionOf('unknown').turn, 'running');
});

test('the loaded hook follows snapshot ownership', async () => {
  reset();
  const host = document.createElement('div');
  const root = createRoot(host);
  let loaded = false;
  function Probe() {
    loaded = S.useSessionLoaded('loaded');
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  assert.equal(loaded, false);
  snapshots.loaded = snap(0);
  await act(async () => S.refreshSession('loaded'));
  assert.equal(loaded, true);
  await act(async () => root.unmount());
});

test('refreshSession takes main snapshot once at a time, keeps a newer copy, and survives a missing or failed one', async () => {
  reset();
  snapshots.a = snap(3, { plan: true });
  const p1 = S.refreshSession('a');
  const p2 = S.refreshSession('a');
  assert.equal(p1, p2);
  await p1;
  assert.equal(named('snapshot').length, 1);
  assert.equal(S.sessionOf('a').plan, true);
  // an older snapshot doesn't replace a newer copy
  snapshots.a = snap(1, { plan: false });
  await S.refreshSession('a');
  assert.equal(S.sessionOf('a').rev, 3);
  // nothing from main: no copy
  await S.refreshSession('none');
  assert.equal(S.useSessions.getState().sessions.none, undefined);
  snapshotFails = true;
  await S.refreshSession('b');
  assert.equal(S.useSessions.getState().sessions.b, undefined);
});

test('loadSession and ensureSession fetch only a chat this window has no copy of', async () => {
  reset();
  snapshots.a = snap(1);
  await S.loadSession('a');
  await S.loadSession('a');
  S.ensureSession('a');
  assert.equal(named('snapshot').length, 1);
  snapshots.b = snap(2);
  S.ensureSession('b');
  await flush();
  assert.equal(S.sessionOf('b').rev, 2);
  assert.equal(S.sessionOf(null), EMPTY_SESSION);
  assert.equal(S.sessionOf('unknown'), EMPTY_SESSION);
});

test('patches from main apply in rev order; a gap takes a new snapshot; startSessions subscribes once', async () => {
  reset();
  S.startSessions();
  S.startSessions();
  assert.equal(named('onPatch').length, 1);
  snapshots.a = snap(1);
  await S.loadSession('a');
  onPatch!({ chatId: 'a', rev: 2, patch: { plan: true } });
  assert.equal(S.sessionOf('a').plan, true);
  // an old patch is ignored
  onPatch!({ chatId: 'a', rev: 2, patch: { plan: false } });
  assert.equal(S.sessionOf('a').plan, true);
  // a missed one: snapshot again
  snapshots.a = snap(9, { permission: 'full-access' });
  onPatch!({ chatId: 'a', rev: 5, patch: {} });
  await flush();
  assert.equal(S.sessionOf('a').rev, 9);
  // no copy yet: also a gap
  onPatch!({ chatId: 'new', rev: 1, patch: {} });
  assert.deepEqual(named('snapshot').at(-1), ['new']);
});

test('a patch arriving during the first snapshot cannot leave the window behind main', async () => {
  reset();
  S.startSessions();
  const first = deferred<any>();
  snapshots.race = first.promise;
  const loading = S.refreshSession('race');
  onPatch!({ chatId: 'race', rev: 2, patch: { approvals: [{ id: 7, method: 'acp/permission', params: {} }] } });
  snapshots.race = snap(2, { approvals: [{ id: 7, method: 'acp/permission', params: {} }] });
  first.resolve(snap(1));
  await loading;
  await flush();
  assert.equal(S.sessionOf('race').rev, 2);
  assert.equal(S.sessionOf('race').approvals[0]?.id, 7);
});

test('gap recovery coalesces revisions per chat and stops when main is missing or remains stale', async () => {
  reset();
  const first = deferred<any>();
  snapshots.a = first.promise;
  S.useSessions.setState({ sessions: { a: snap(1), b: snap(1) } });
  onPatch!({ chatId: 'a', rev: 3, patch: { plan: true } });
  onPatch!({ chatId: 'a', rev: 4, patch: { permission: 'ask' } });
  onPatch!({ chatId: 'a', rev: 5, patch: { plan: false } });
  snapshots.b = snap(7);
  onPatch!({ chatId: 'b', rev: 7, patch: {} });
  snapshots.a = snap(5, { permission: 'ask' });
  first.resolve(snap(3, { plan: true }));
  await flush();
  assert.equal(S.sessionOf('a').rev, 5);
  assert.equal(S.sessionOf('a').permission, 'ask');
  assert.equal(S.sessionOf('b').rev, 7);
  assert.equal(named('snapshot').filter(([id]) => id === 'a').length, 2);
  // An answer already covering the observed gap needs no extra request.
  const covered = deferred<any>();
  snapshots.covered = covered.promise;
  const loading = S.refreshSession('covered');
  onPatch!({ chatId: 'covered', rev: 8, patch: {} });
  covered.resolve(snap(8));
  await loading;
  assert.equal(named('snapshot').filter(([id]) => id === 'covered').length, 1);
  // A gap known before the request is not evidence for retrying a stale answer forever.
  snapshots.stale = snap(1);
  onPatch!({ chatId: 'stale', rev: 8, patch: {} });
  await flush();
  assert.equal(named('snapshot').filter(([id]) => id === 'stale').length, 1);
});

test('setSession shows the change at once and takes main copy again when main saw no change', async () => {
  reset();
  snapshots.a = snap(4);
  // no copy at rev > 0 yet: a snapshot is taken as well
  patchResult = true;
  assert.equal(await S.setSession('a', { plan: true }), true);
  assert.deepEqual(named('patch'), [['a', { plan: true }]]);
  assert.equal(named('snapshot').length, 1);
  await flush();
  calls.length = 0;
  patchResult = false;
  assert.equal(await S.setSession('a', { goal: null }), false);
  assert.equal(named('snapshot').length, 1);
  calls.length = 0;
  patchResult = Promise.reject(new Error('closed'));
  assert.equal(await S.setSession('a', { plan: false }), false);
  assert.equal(S.sessionOf('a').plan, false);
});

test('a rejected session write refreshes main state rather than leaving an optimistic setting applied', async () => {
  reset();
  S.useSessions.setState({ sessions: { rejected: snap(3) } });
  snapshots.rejected = snap(3);
  patchResult = Promise.reject(new Error('disconnected'));
  assert.equal(await S.setSession('rejected', { plan: true, permission: 'full-access' }), false);
  await flush();
  assert.equal(S.sessionOf('rejected').plan, false);
  assert.equal(S.sessionOf('rejected').permission, null);
  assert.equal(named('snapshot').filter(([id]) => id === 'rejected').length, 1);
});

test('write failure recovery preserves newer pushed state and remains retryable after a failed snapshot', async () => {
  reset();
  S.useSessions.setState({ sessions: { recovery: snap(3) } });
  const recovery = deferred<any>();
  snapshots.recovery = recovery.promise;
  patchResult = Promise.reject(new Error('reply lost'));
  assert.equal(await S.setSession('recovery', { plan: true }), false);
  onPatch!({ chatId: 'recovery', rev: 4, patch: { plan: true } });
  recovery.resolve(snap(3));
  await flush();
  assert.equal(S.sessionOf('recovery').rev, 4);
  assert.equal(S.sessionOf('recovery').plan, true);
  snapshotFails = true;
  patchResult = Promise.reject(new Error('closed'));
  assert.equal(await S.setSession('recovery', { permission: 'full-access' }), false);
  await flush();
  snapshotFails = false;
  snapshots.recovery = snap(5, { plan: true, permission: 'ask' });
  await S.refreshSession('recovery');
  assert.equal(S.sessionOf('recovery').permission, 'ask');
});

test('write recovery must take a snapshot after the reply even when an older read is in flight', async () => {
  reset();
  S.useSessions.setState({ sessions: { overlap: snap(3) } });
  const old = deferred<any>();
  snapshots.overlap = old.promise;
  const loading = S.refreshSession('overlap');
  // Main may have applied the write even though its reply was lost, without the window
  // receiving the corresponding push. The pre-write snapshot cannot settle that ambiguity.
  patchResult = Promise.reject(new Error('reply lost'));
  assert.equal(await S.setSession('overlap', { plan: true }), false);
  snapshots.overlap = snap(4, { plan: true });
  old.resolve(snap(3));
  await loading;
  await flush();
  assert.equal(S.sessionOf('overlap').rev, 4);
  assert.equal(S.sessionOf('overlap').plan, true);
  assert.equal(named('snapshot').filter(([id]) => id === 'overlap').length, 2);
});

test('useSession follows a chat once mounted, and an empty session without one', async () => {
  reset();
  snapshots.a = snap(7);
  const seen: number[] = [];
  const View = ({ id }: { id: string | null }) => {
    seen.push(S.useSession(id).rev);
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(View, { id: null })));
  assert.equal(named('snapshot').length, 0);
  await act(async () => root.render(createElement(View, { id: 'a' })));
  await act(flush);
  assert.equal(seen.at(-1), 7);
  await act(async () => root.unmount());
});

test('NO_CAPS offers nothing until main answers', () => {
  for (const cap of Object.values(C.NO_CAPS.caps)) assert.deepEqual({ state: cap.state, via: cap.via }, { state: 'absent', via: 'none' });
  assert.equal(C.NO_CAPS.kind, 'codex');
});

test('capsOf asks main and answers null when it fails', async () => {
  capsResult = async (id) => ({ kind: 'claude', tier: 'first', caps: { id } });
  assert.deepEqual(await C.capsOf(undefined), { kind: 'claude', tier: 'first', caps: { id: null } });
  capsResult = () => Promise.reject(new Error('x'));
  assert.equal(await C.capsOf('c1', { kind: 'codex' }), null);
});

test('startCaps follows main notice once and bumps the generation', () => {
  calls.length = 0;
  C.startCaps();
  C.startCaps();
  assert.equal(named('onCapsChanged').length, 1);
  const gen = C.useCapsStore.getState().gen;
  onCapsChanged!();
  assert.equal(C.useCapsStore.getState().gen, gen + 1);
});

test('useChatCaps, useCaps and useCap read what main answered for the chat and hint, and ask again on a notice', async () => {
  reset();
  const gate = deferred<any>();
  const answer = (kind: string) => ({ kind, tier: 'first', caps: { goal: { state: 'native', via: 'native' } } });
  capsResult = (id) =>
    id === 'slow'
      ? gate.promise
      : id === 'none'
        ? Promise.resolve(null)
        : id === 'bad'
          ? Promise.reject(new Error('x'))
          : Promise.resolve(answer(id === 'c1' ? 'claude' : 'codex'));
  const out: Record<string, any> = {};
  const View = ({ id, hint, tag }: { id: string | null; hint?: any; tag: string }) => {
    const all = C.useChatCaps(id, hint);
    out[tag] = { kind: all.kind, loaded: all.loaded, caps: C.useCaps(id, hint), goal: C.useCap(id, 'goal', hint) };
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement(View, { id: 'c1', tag: 'a' }),
        createElement(View, { id: null, hint: { kind: 'codex', model: 'm', temporary: true, elsewhere: false }, tag: 'b' }),
        createElement(View, { id: 'slow', tag: 'c' }),
        createElement(View, { id: 'slow', tag: 'd' }),
        createElement(View, { id: 'none', tag: 'e' }),
        createElement(View, { id: 'bad', tag: 'f' }),
      ),
    ),
  );
  await act(flush);
  assert.deepEqual(out.a.goal, { state: 'native', via: 'native' });
  assert.equal(out.a.kind, 'claude');
  assert.equal(out.a.loaded, true);
  assert.equal(out.b.kind, 'codex');
  assert.equal(out.c.loaded, false);
  assert.equal(out.e.loaded, false);
  assert.equal(out.f.caps.goal.state, 'absent');
  // the two views of the slow chat share one request
  assert.equal(named('caps').filter(([id]) => id === 'slow').length, 1);
  await act(async () => (gate.resolve(answer('slow')), await flush()));
  assert.equal(out.d.loaded, true);
  const before = named('caps').length;
  await act(async () => onCapsChanged!());
  await act(flush);
  assert.ok(named('caps').length > before);
  await act(async () => root.unmount());
});

test('capability invalidation during a fetch cannot publish its stale answer or lose the refresh', async () => {
  reset();
  const old = deferred<any>();
  const fresh = { kind: 'claude', tier: 'first', caps: { goal: { state: 'disabled', via: 'none' } } };
  capsResult = () => old.promise;
  let seen: any;
  const View = () => {
    seen = C.useChatCaps('caps-race');
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(View)));
  capsResult = async () => fresh;
  await act(async () => onCapsChanged!());
  await act(flush);
  await act(async () => {
    old.resolve({ ...fresh, caps: { goal: { state: 'native', via: 'native' } } });
    await flush();
  });
  assert.equal(seen.caps.goal.state, 'disabled');
  assert.equal(named('caps').filter(([id]) => id === 'caps-race').length, 2);
  await act(async () => root.unmount());
});

test('a session revision changing during a capability fetch supersedes the old request', async () => {
  reset();
  const old = deferred<any>();
  const fresh = { kind: 'codex', tier: 'first', caps: { goal: { state: 'disabled', via: 'none' } } };
  capsResult = () => old.promise;
  let seen: any;
  const View = () => {
    seen = C.useChatCaps('rev-race');
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(View)));
  capsResult = async () => fresh;
  await act(async () => S.useSessions.setState({ sessions: { 'rev-race': snap(1, { turn: 'running' }) } }));
  await act(flush);
  await act(async () => {
    old.resolve({ ...fresh, caps: { goal: { state: 'native', via: 'native' } } });
    await flush();
  });
  assert.equal(seen.caps.goal.state, 'disabled');
  assert.equal(named('caps').filter(([id]) => id === 'rev-race').length, 2);
  await act(async () => root.unmount());
});

test('failed capability refreshes cannot keep an older generation or revision marked loaded', async () => {
  reset();
  const available = { kind: 'claude', tier: 'first', caps: { goal: { state: 'native', via: 'native' } } };
  for (const change of ['generation', 'revision']) {
    for (const failure of ['null', 'rejected']) {
      const id = `cached-${change}-${failure}`;
      capsResult = async () => available;
      let seen: any;
      const View = () => {
        seen = C.useChatCaps(id);
        return null;
      };
      const root = createRoot(document.createElement('div'));
      await act(async () => root.render(createElement(View)));
      await act(flush);
      assert.equal(seen.loaded, true);
      capsResult = async () => {
        if (failure === 'rejected') throw new Error('unavailable');
        return null;
      };
      await act(async () => {
        if (change === 'generation') onCapsChanged!();
        else S.useSessions.setState((s) => ({ sessions: { ...s.sessions, [id]: snap(1, { turn: 'running' }) } }));
      });
      await act(flush);
      assert.equal(seen.loaded, false);
      assert.equal(seen.caps.goal.state, 'absent');
      // A later successful invalidation makes the current answer available again.
      capsResult = async () => ({ ...available, caps: { goal: { state: 'disabled', via: 'none' } } });
      await act(async () => onCapsChanged!());
      await act(flush);
      assert.equal(seen.loaded, true);
      assert.equal(seen.caps.goal.state, 'disabled');
      await act(async () => root.unmount());
    }
  }
});

test('useChatCaps asks once per chat and hint values, with the latest hint, the same way for Codex, Claude Code and ACP', async () => {
  for (const kind of ['codex', 'claude', 'acp:kimi']) {
    reset();
    capsResult = async (_id, hint) => ({ kind: hint?.kind ?? kind, tier: 'first', caps: { goal: { state: 'native', via: 'native' } } });
    const asked = () => named('caps').filter(([, hint]) => hint?.marker === kind);
    let seen: any;
    // callers build the hint object anew on every render
    const View = ({ chat, model }: { chat: string | null; model: string }) => {
      seen = C.useChatCaps(chat, { kind, model, marker: kind } as any);
      return null;
    };
    const root = createRoot(document.createElement('div'));
    const show = (chat: string | null, model: string) => act(async () => root.render(createElement(View, { chat, model })));
    try {
      await show(null, 'm1');
      await act(flush);
      await show(null, 'm1');
      await act(flush);
      assert.equal(asked().length, 1, `${kind}: a rebuilt hint with the same values asks once`);
      assert.equal(seen.loaded, true);
      assert.equal(seen.kind, kind);
      // another model: asked again, with this render's hint
      await show(null, 'm2');
      await act(flush);
      assert.deepEqual(
        asked().map(([id, hint]) => [id, hint.model]),
        [
          [null, 'm1'],
          [null, 'm2'],
        ],
      );
      // the chat starts: asked for the chat, with the hint it was given
      await show(`${kind}-chat`, 'm2');
      await act(flush);
      assert.deepEqual(asked().at(-1), [`${kind}-chat`, { kind, model: 'm2', marker: kind }]);
      assert.equal(seen.loaded, true);
      assert.equal(asked().length, 3);
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('runSemantic refusalText without a harness falls back to the undeclared reason', async () => {
  const { refusalText } = await import('../src/store/session/runSemantic.ts');
  assert.equal(typeof refusalText({ ok: false, state: 'absent', why: null }, 'compact'), 'string');
});

test('capsTypes is types only, and Windows homes get Windows separators for default folders', async () => {
  assert.deepEqual(await runtimeExports(import('../src/store/session/capsTypes.ts')), []);
  const { worktreeRootOf, projectlessFolderOf } = await import('../src/store/types.ts');
  assert.equal(worktreeRootOf({ worktreeRoot: null }, 'C:\\Users\\me\\'), 'C:\\Users\\me\\.mopilot\\worktrees');
  assert.equal(projectlessFolderOf({ projectlessFolder: null }, '\\\\server\\me'), '\\\\server\\me\\Documents\\MoPilot');
  assert.equal(worktreeRootOf({ worktreeRoot: null }, '/Users/me'), '/Users/me/.mopilot/worktrees');
});
