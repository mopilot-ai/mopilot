// src/session/chatRowState.ts, nestedHidden.ts and sideSessions.ts' nested helpers: one status per sidebar row on every
// harness (a linked session's last report shows done or failed), how hidden nested sessions count and read, and the
// per-view hidden choice kept in localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { chatRowState, nestedTally, type ChatRowInputs, type ChatRowState } from '../src/session/chatRowState.ts';
import { nestedFamily, nestedSummary, trailTo } from '../src/lib/sideSessions.ts';
import {
  hiddenIn,
  nestedHidden,
  resetNestedHidden,
  setNestedHidden,
  useNestedHidden,
  useNestedHiddenKeys,
} from '../src/lib/nestedHidden.ts';
import { EMPTY_SESSION } from '../src/store/session/sessionState.ts';

const report = (how: 'finished' | 'failed' | 'stopped' | 'lost') => ({
  parentId: 'top',
  name: 'kid',
  title: 'kid',
  harness: null,
  useWorktree: false,
  createdAt: 1,
  lastReport: { how, report: null, at: 2 },
});
const state = (over: Partial<ChatRowInputs> = {}): ChatRowState =>
  chatRowState({
    thread: { id: 'c', cwd: '/repo', status: { type: 'idle' } } as ChatRowInputs['thread'],
    session: EMPTY_SESSION,
    runtime: undefined,
    requests: [],
    adapterTasks: [],
    elsewhere: undefined,
    unread: false,
    ...over,
  });
const live = (over: Record<string, unknown>) => ({ ...EMPTY_SESSION, rev: 1, ...over }) as ChatRowInputs['session'];
const active = (activeFlags: string[]) => ({ id: 'c', cwd: '/repo', status: { type: 'active', activeFlags } }) as ChatRowInputs['thread'];

test('a row says what most needs the user first: approval, input, failure, work, then another app', () => {
  // main's session: its approvals, typed (a Sage approval passes as it came), decide
  assert.equal(state({ session: live({ approvals: [{ id: 'a', method: 'item/tool/requestUserInput', params: {} }] }) }), 'input');
  assert.equal(state({ session: live({ approvals: [{ id: 'a', method: 'sage/approval', params: {} }] }) }), 'approval');
  assert.equal(state({ session: live({ chromeApproval: true }) }), 'approval');
  assert.equal(state({ session: live({ turn: 'awaitingUser' }) }), 'approval');
  assert.equal(
    state({ session: live({ turn: 'awaitingUser', approvals: [{ id: 'a', method: 'mcpServer/elicitation/request', params: {} }] }) }),
    'input',
    'a question the user answers is input, not an approval',
  );
  assert.equal(state({ session: live({ turn: 'crashed' }) }), 'error');
  assert.equal(state({ session: live({ turn: 'running' }) }), 'working');
  assert.equal(state({ session: live({ runningElsewhere: true }) }), 'elsewhereRunning');
  // before main has it: the store's requests for this chat only, and the native list's flags and status
  const ask = (threadId: string, method: string) => ({ id: 1, threadId, method, params: {} }) as never;
  assert.equal(state({ requests: [ask('other', 'item/tool/requestUserInput')] }), 'idle');
  assert.equal(state({ requests: [ask('c', 'item/commandExecution/requestApproval')] }), 'approval');
  assert.equal(state({ thread: active(['waitingOnUserInput']) }), 'input');
  assert.equal(state({ thread: active(['waitingOnApproval']) }), 'approval');
  assert.equal(state({ thread: active([]) }), 'working');
  assert.equal(state({ thread: { id: 'c', cwd: null, status: { type: 'systemError' } } as never }), 'error');
  assert.equal(state({ runtime: { error: 'boom', turns: [] } as never }), 'error');
  assert.equal(state({ runtime: { turns: [{ status: 'failed' }] } as never }), 'error');
  assert.equal(state({ runtime: { activeTurnId: 't', turns: [{ status: 'failed' }] } as never }), 'working', 'a retry runs');
  assert.equal(state({ elsewhere: { app: 'codex', running: true } as never }), 'elsewhereRunning');
  assert.equal(state({ elsewhere: { app: 'codex', running: false } as never }), 'elsewhere');
});

test('a linked session shows its last report: failed or lost over unread, finished after it is read', () => {
  assert.equal(state({ linked: report('failed') }), 'failed');
  assert.equal(state({ linked: report('lost'), unread: true }), 'failed');
  assert.equal(state({ linked: report('finished'), unread: true }), 'unread');
  assert.equal(state({ linked: report('finished') }), 'done');
  assert.equal(state({ linked: report('stopped') }), 'idle', 'the user stopped it: nothing to say');
  assert.equal(state({ linked: { ...report('finished'), lastReport: null } }), 'idle');
  assert.equal(state({ linked: report('finished'), session: live({ turn: 'running' }) }), 'working', 'a new turn supersedes the report');
  assert.equal(state({ unread: true }), 'unread');
});

test('each hidden session counts once, as its most pressing state', () => {
  const expect: Record<ChatRowState, ReturnType<typeof nestedTally>> = {
    approval: 'input',
    input: 'input',
    error: 'failed',
    failed: 'failed',
    unread: 'unread',
    working: 'working',
    elsewhereRunning: 'working',
    done: null,
    elsewhere: null,
    idle: null,
  };
  for (const [s, tally] of Object.entries(expect)) assert.equal(nestedTally(s as ChatRowState), tally, s);
});

test('the summary reads the count, then each nonzero state in order; "more" when some still show', () => {
  assert.deepEqual(nestedSummary(1, { input: 0, failed: 0, unread: 0, working: 0 }, false), {
    label: '1 nested session',
    parts: [],
    aria: 'Show 1 nested session',
  });
  assert.deepEqual(nestedSummary(5, { input: 1, failed: 2, unread: 1, working: 1 }, false), {
    label: '5 nested sessions',
    parts: [
      { kind: 'input', text: '1 needs input' },
      { kind: 'failed', text: '2 failed' },
      { kind: 'unread', text: '1 unread' },
      { kind: 'working', text: '1 working' },
    ],
    aria: 'Show 5 nested sessions, 1 needs input, 2 failed, 1 unread, 1 working',
  });
  assert.deepEqual(
    nestedSummary(2, { input: 2, failed: 0, unread: 0, working: 0 }, true).aria,
    'Show 2 more nested sessions, 2 need input',
  );
  assert.equal(nestedSummary(1, { input: 0, failed: 0, unread: 0, working: 3 }, true).label, '1 more nested session');
});

test('a family is the roots and every listed chat below them, once, stopping at the chats above and at loops', () => {
  const child = (parentId: string, createdAt: number) => ({ parentId, createdAt }) as never;
  const v = {
    children: {
      a: child('p', 1),
      b: child('p', 2),
      a1: child('a', 3),
      a2: child('a', 4),
      gone: child('a', 5),
      loop: child('a1', 6),
      p: child('loop', 7),
    },
  } as never;
  const listed = ['p', 'a', 'b', 'a1', 'a2', 'loop'];
  assert.deepEqual(nestedFamily(v, ['a', 'b'], listed, ['p']), ['a', 'a1', 'loop', 'a2', 'b']);
  assert.deepEqual(nestedFamily(v, ['a', 'a1'], listed), ['a', 'a1', 'loop', 'p', 'b', 'a2'], 'each once, even through a loop');
  assert.deepEqual(nestedFamily(v, ['gone'], listed), [], 'an unlisted chat hides nothing');
  // the way down from a parent to a chat below it
  assert.deepEqual(trailTo(v, 'p', 'loop'), ['a', 'a1', 'loop']);
  assert.deepEqual(trailTo(v, 'a', 'a'), [], 'the parent itself is not below it');
  assert.deepEqual(trailTo(v, 'b', 'a2'), [], 'not below it: the walk up loops and stops');
  assert.deepEqual(trailTo(v, 'p', 'other'), [], 'a chat no one started');
});

test('the hidden choice is per view and chat, kept in localStorage, and survives unreadable or full storage', () => {
  localStorage.clear();
  resetNestedHidden();
  assert.equal(nestedHidden('project', 'p'), false, 'every chat starts with its nested sessions shown');
  setNestedHidden('project', ['p', 'q'], true);
  assert.equal(nestedHidden('project', 'p'), true);
  assert.equal(nestedHidden('list', 'p'), false, 'another view keeps its own choice');
  assert.deepEqual(JSON.parse(localStorage.getItem('mopilot.nestedHidden')!), ['project:p', 'project:q']);
  setNestedHidden('project', ['p'], true);
  assert.deepEqual(JSON.parse(localStorage.getItem('mopilot.nestedHidden')!), ['project:q', 'project:p'], 'once each');
  setNestedHidden('project', ['p'], false);
  resetNestedHidden();
  assert.deepEqual([nestedHidden('project', 'p'), nestedHidden('project', 'q')], [false, true], 'read back after a reload');
  // only the latest 500 are kept
  setNestedHidden(
    'recents',
    Array.from({ length: 600 }, (_, i) => `c${i}`),
    true,
  );
  const kept = JSON.parse(localStorage.getItem('mopilot.nestedHidden')!) as string[];
  assert.deepEqual([kept.length, kept[0], kept.at(-1)], [500, 'recents:c100', 'recents:c599']);

  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => void warned.push(m);
  try {
    for (const saved of ['{oops', '{"a":1}', '["project:x", 3]']) {
      localStorage.setItem('mopilot.nestedHidden', saved);
      resetNestedHidden();
      assert.equal(nestedHidden('project', 'q'), false, saved);
    }
    assert.equal(nestedHidden('project', 'x'), true, 'the readable entries of a damaged list still count');
    const real = globalThis.localStorage;
    (globalThis as { localStorage: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    };
    try {
      setNestedHidden('project', ['y'], true);
      assert.equal(nestedHidden('project', 'y'), true, 'it holds for this window');
    } finally {
      (globalThis as { localStorage: unknown }).localStorage = real;
    }
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warned, ['Could not read which nested sessions are hidden', 'Could not save which nested sessions are hidden']);
});

/** What another window's write fires here. */
const storage = (key: string) => Object.assign(new Event('storage'), { key });

test('hooks follow this window’s changes and another window’s through the storage event', async () => {
  localStorage.clear();
  resetNestedHidden();
  const seen: [boolean, boolean][] = [];
  function Probe() {
    const keys = useNestedHiddenKeys();
    seen.push([useNestedHidden('list', 'p'), hiddenIn(keys, 'list', 'q')]);
    return null;
  }
  const root = createRoot(document.createElement('div') as never);
  await act(async () => root.render(createElement(Probe)));
  await act(async () => setNestedHidden('list', ['p'], true));
  assert.deepEqual(seen.at(-1), [true, false]);
  // another window wrote the list: this one reads it again
  localStorage.setItem('mopilot.nestedHidden', JSON.stringify(['list:q']));
  await act(async () => void window.dispatchEvent(storage('other')));
  assert.deepEqual(seen.at(-1), [true, false], 'another key is not ours');
  await act(async () => void window.dispatchEvent(storage('mopilot.nestedHidden')));
  assert.deepEqual(seen.at(-1), [false, true]);
  await act(async () => root.unmount());
});
