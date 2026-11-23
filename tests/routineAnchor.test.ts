// Action memory's anchors in main (#3571, G4; electron/capabilities/routines/routineAnchor.cjs): a ref in an
// out-of-process frame gets each frame element above it as steps, a point is anchored in the top frame, the targets of a
// call (a batch's too) are read before it runs on the tab it names. A replay no longer finds a target (it never acts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const A = createRequire(import.meta.url)('../electron/capabilities/routines/routineAnchor.cjs');

const step = (name: string) => ({ k: 'role', role: 'button', name: { s: name, exact: true } });
const IFRAME = (name: string) => ({ k: 'role', role: 'iframe', name: { s: name, exact: true } });

/** A tab whose page agent answers `anchor` per session, with frames `inner` (in `outer`) and `outer` (in the top). */
function fakeTab(answers: Record<string, any>, o: any = {}) {
  const calls: any[] = [];
  return {
    calls,
    url: o.url ?? 'https://a.test/x',
    frames: new Map([
      ['outer', { sessionId: 'outer', parent: '' }],
      ['inner', { sessionId: 'inner', parent: 'outer' }],
    ]),
    frameOf: (ref: string) => (o.frameOf ? o.frameOf(ref) : ref.startsWith('in:') ? 'inner' : ''),
    ownerRef: async (frame: any) => `owner:${frame.sessionId}`,
    agent: async (op: string, args: any, sid = '') => {
      calls.push({ op, args, sid });
      const key = args.ref ?? `${args.x},${args.y}`;
      return answers[`${sid}|${key}`] ?? null;
    },
  };
}

test('anchorIn: a ref in nested out-of-process frames gets each frame element, a frame step, then its own steps', async () => {
  const tab = fakeTab({
    'inner|in:pay': { steps: [step('Pay')], weak: false, secret: true },
    'outer|owner:inner': { steps: [IFRAME('Card')], weak: true },
    '|owner:outer': { steps: [IFRAME('Checkout')], weak: false },
  });
  assert.deepEqual(await A.anchorIn(tab, 'ref:in:pay'), {
    steps: [IFRAME('Checkout'), { k: 'frame' }, IFRAME('Card'), { k: 'frame' }, step('Pay')],
    weak: true,
    secret: true,
  });
});

test('anchorIn: a point is anchored in the top frame; what the agent cannot anchor stays as it said', async () => {
  const tab = fakeTab({ '|5,6': { steps: [step('Go')] }, '|ref_1': { frame: true } });
  assert.deepEqual(await A.anchorIn(tab, 'at:5,6'), { steps: [step('Go')] });
  assert.deepEqual(await A.anchorIn(tab, 'ref:ref_1'), { frame: true });
  assert.equal(await A.anchorIn(tab, 'ref:ref_2'), null);
});

test('anchorIn: a frame that went away, or a frame element the agent cannot anchor, leaves the target unanchored', async () => {
  const gone = fakeTab({ 'lost|r': { steps: [step('X')] } }, { frameOf: () => 'lost' });
  assert.equal(await A.anchorIn(gone, 'ref:r'), null);
  const blind = fakeTab({ 'inner|in:x': { steps: [step('X')] } });
  assert.equal(await A.anchorIn(blind, 'ref:in:x'), null);
});

/** The chat's tabs: `resolve` for a named tab, `current` otherwise, `run` serializing, `query` answering per try. */
function fakeTabs(tab: any, o: any = {}) {
  const runs: string[] = [];
  return {
    runs,
    resolve: async (_chat: string, id: string) => {
      if (o.missing) throw new Error('no such tab');
      runs.push(`resolve:${id}`);
      return tab;
    },
    current: () => tab,
    run: async (t: any, fn: () => any) => {
      assert.equal(t, tab);
      runs.push('run');
      return fn();
    },
    query: async (_t: any, steps: any[], opts: any) => {
      assert.deepEqual(opts, { limit: 2 });
      return o.query(steps);
    },
  };
}

test("anchorsBefore: every target of a call, a batch's included, read once on the tab it names", async () => {
  const tab = fakeTab({ '|ref_1': { steps: [step('A')] }, '|1,2': { steps: [step('B')] } });
  const tabs = fakeTabs(tab);
  const args = {
    tabId: '7',
    actions: [
      { name: 'computer', input: { action: 'left_click', ref: 'ref_1' } },
      { name: 'computer', input: { action: 'left_click', ref: 'ref_1' } },
      { name: 'computer', input: { action: 'left_click', coordinate: [1, 2] } },
      { name: 'computer', input: { action: 'left_click', ref: 'ref_9' } },
    ],
  };
  const { anchors, url } = await A.anchorsBefore(tabs, 'c1', 'browser_batch', args);
  assert.deepEqual([...anchors.keys()], ['ref:ref_1', 'at:1,2', 'ref:ref_9']);
  assert.equal(anchors.get('ref:ref_9'), null);
  assert.equal(url, 'https://a.test/x');
  assert.deepEqual(tabs.runs, ['resolve:7', 'run']);
  assert.equal(tab.calls.filter((c) => c.args.ref === 'ref_1').length, 1, 'a repeated target is read once');
});

test('anchorsBefore: no tab, a missing named tab, a call with no target, a target that throws', async () => {
  const none = { current: () => null, resolve: async () => null, run: async () => undefined };
  assert.deepEqual(await A.anchorsBefore(none, 'c', 'browser_computer', { action: 'left_click', ref: 'r' }), {
    anchors: new Map(),
    url: null,
  });
  const tab = fakeTab({});
  const missing = fakeTabs(tab, { missing: true });
  assert.equal((await A.anchorsBefore(missing, 'c', 'browser_computer', { tabId: '9', ref: 'r' })).url, null);
  const plain = fakeTabs(tab);
  assert.deepEqual(await A.anchorsBefore(plain, 'c', 'browser_computer', { action: 'key', text: 'a' }), {
    anchors: new Map(),
    url: tab.url,
  });
  assert.deepEqual(plain.runs, [], 'no target: the tab is not taken');
  const throwing = {
    ...tab,
    frameOf: () => {
      throw new Error('stale');
    },
  };
  const out = await A.anchorsBefore(fakeTabs(throwing), 'c', 'browser_computer', { ref: 'r' });
  assert.equal(out.anchors.size, 0, 'a stale ref is left unanchored');
  const noUrl = { ...tab, url: undefined };
  assert.equal((await A.anchorsBefore(fakeTabs(noUrl), 'c', 'browser_computer', {})).url, null);
});

test('currentUrl: the current tab address, else null', () => {
  assert.equal(A.currentUrl({ current: () => ({ url: 'https://x.test/' }) }, 'c'), 'https://x.test/');
  assert.equal(A.currentUrl({ current: () => ({}) }, 'c'), null);
  assert.equal(A.currentUrl({ current: () => null }, 'c'), null);
});

test("anchorsBefore: a chrome_* call names Chrome's own numeric tab id, found among the chat's tabs", async () => {
  const tab = { ...fakeTab({ '|ref_1': { steps: [step('A')] } }), backend: { tabId: 41 } };
  const tabs = { ...fakeTabs(tab), list: () => [{ backend: { tabId: 7 } }, tab] };
  const { anchors } = await A.anchorsBefore(tabs, 'c', 'chrome_computer', { action: 'left_click', ref: 'ref_1', tabId: 41 });
  assert.deepEqual(anchors.get('ref:ref_1'), { steps: [step('A')], weak: false, secret: false });
  assert.deepEqual(tabs.runs, ['run'], 'not resolved as a host tab id');
});

test('browserAdapter: tabs given or by a function; none up anchors nothing and has no page', async () => {
  const none = A.browserAdapter(() => null);
  assert.equal(none.up(), false);
  assert.deepEqual(await none.anchorsBefore('c', 'browser_computer', { ref: 'r' }), { anchors: new Map(), url: null });
  assert.equal(none.url('c'), null);
  const tab = fakeTab({ '|ref_1': { steps: [step('A')] } });
  const one = A.browserAdapter(fakeTabs(tab, { query: () => ({ count: 1, refs: ['ref_4'] }) }));
  assert.equal(one.up(), true);
  assert.equal(one.url('c'), 'https://a.test/x');
  assert.deepEqual((await one.anchorsBefore('c', 'browser_computer', { ref: 'ref_1' })).anchors.get('ref:ref_1').steps, [step('A')]);
  assert.equal('resolve' in one, false, 'a replay finds no target: it never acts');
});
