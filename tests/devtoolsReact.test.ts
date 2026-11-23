// browser_react (devtools/react.cjs, reactPage.cjs): the component tree, inspect and render counts over hand-built React fibers in happy-dom, and the tool's actions, gates and text.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const { reactPage, renderHook, REACT_SOURCE, RENDER_HOOK } = require('../electron/capabilities/browser/devtools/reactPage.cjs');
const { reactTool, inPage, NO_REACT } = require('../electron/capabilities/browser/devtools/react.cjs');

const g = globalThis as any;
const saved = ['window', 'document', 'Node'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
after(() => {
  for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete g[k];
});
/** A fresh page: happy-dom's window as the page's globals. */
function page(html = '<div id="root"><span id="leaf"></span></div>') {
  const win: any = new Window();
  win.document.body.innerHTML = html;
  for (const [k, v] of [
    ['window', win],
    ['document', win.document],
    ['Node', win.Node],
  ] as const)
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  return win;
}

function App() {}
function Item() {}
class Counter {
  static displayName = 'Counter!';
}
/** HostRoot -> App (hooks, props) -> div -> [memo(Item) key a, Counter (class state), forwardRef(anonymous)] */
function fibers() {
  const hostRoot: any = { tag: 3 };
  const item: any = { tag: 15, type: Item, key: 'a', memoizedProps: {}, memoizedState: null };
  const counter: any = { tag: 1, type: Counter, key: null, memoizedProps: { n: 1 }, memoizedState: { count: 2 } };
  const fwd: any = { tag: 11, type: { render: [() => null][0] }, key: null, memoizedProps: {}, memoizedState: null };
  item.sibling = counter;
  counter.sibling = fwd;
  const div: any = { tag: 5, type: 'div', child: item };
  const app: any = {
    tag: 0,
    type: App,
    key: null,
    child: div,
    memoizedProps: {
      title: 'Shop',
      password: 'hunter2',
      long: 'x'.repeat(250),
      onClick: function click() {},
      anon: Object.assign(() => {}, { displayName: '' }),
      el: { $$typeof: Symbol.for('react.element'), type: Item },
      deep: { a: { b: { c: 1 } }, list: [1, [2, [3]]] },
      sym: Symbol('s'),
      nil: null,
      tags: ['a', 1],
    },
    memoizedState: { memoizedState: 'typed', next: { memoizedState: { open: true }, next: null } },
    _debugSource: { fileName: 'App.tsx', lineNumber: 3 },
    _debugOwner: null,
  };
  for (const f of [item, counter, fwd]) Object.assign(f, { _debugOwner: app, return: div });
  div.return = app;
  app.return = hostRoot;
  hostRoot.child = app;
  hostRoot.stateNode = { current: hostRoot };
  return { hostRoot, app, item, counter, fwd };
}

test('tree lists components from a root container with ids, keys and depth; ids stay stable', () => {
  const win = page();
  const f = fibers();
  win.document.getElementById('root').__reactContainer$x = f.hostRoot;
  // the same root reached again from a fiber on a node is one root
  win.document.getElementById('leaf').__reactFiber$x = f.item;
  const t = reactPage({ op: 'tree' });
  assert.deepEqual(t, { react: true, count: 4, lines: ['App [1]', '  Item [2] key="a"', '  Counter! [3]', '  Anonymous [4]'] });
  // after a commit React swaps in the alternate: a new fiber object whose alternate is known keeps its id
  f.hostRoot.child = { ...f.app, alternate: f.app };
  const again = reactPage({ op: 'tree', maxNodes: 2 });
  assert.deepEqual(again.lines, ['App [1]', '  Item [2] key="a"']);
  assert.equal(again.count, 4);
});

test('a legacy root and a fiber-only page are found; a page without React is not', () => {
  let win = page();
  let f = fibers();
  win.document.getElementById('root')._reactRootContainer = { _internalRoot: { current: f.hostRoot } };
  win.document.getElementById('root')._reactRootContainer2 = 1;
  assert.equal(reactPage({ op: 'tree' }).count, 4);
  win = page();
  f = fibers();
  win.document.getElementById('leaf').__reactFiber$y = f.counter;
  assert.equal(reactPage({ op: 'tree' }).count, 4);
  // a root container whose value is no fiber, a legacy container with no root, and an empty page
  win = page();
  win.document.getElementById('root').__reactContainer$z = {};
  win.document.getElementById('leaf')._reactRootContainer = {};
  assert.deepEqual(reactPage({ op: 'tree' }), { react: false, lines: [], count: 0 });
  // a root whose stateNode keeps no current tree is walked as it is
  win = page();
  f = fibers();
  f.hostRoot.stateNode = {};
  win.document.getElementById('root').__reactContainer$x = f.hostRoot;
  assert.equal(reactPage({ op: 'tree' }).count, 4);
});

test('inspect shows props, hooks, class state, owners and source, with secrets REDACTED and strings hidden on a sign-in page', () => {
  const win = page();
  const f = fibers();
  win.document.getElementById('root').__reactContainer$x = f.hostRoot;
  f.app.memoizedProps.node = win.document.getElementById('leaf');
  reactPage({ op: 'tree' });
  const ids = (window as any)[Symbol.for('mopilot.react')];
  const idOf = (fiber: any) => ids.ids.get(fiber);
  const app = reactPage({ op: 'inspect', id: idOf(f.app) });
  assert.equal(app.name, 'App');
  assert.equal(app.source, 'App.tsx:3');
  assert.deepEqual(app.owners, []);
  assert.equal(app.props.password, 'REDACTED');
  assert.equal(app.props.title, 'Shop');
  assert.equal(app.props.long, `${'x'.repeat(200)}… [+50 chars]`);
  assert.equal(app.props.onClick, 'ƒ click');
  assert.equal(app.props.anon, 'ƒ anonymous');
  assert.equal(app.props.el, '<Item>');
  assert.equal(app.props.node, '<span>');
  // props are depth 0, so a prop's own fields are the last level shown
  assert.deepEqual(app.props.deep, { a: '{…}', list: '[2]' });
  assert.equal(app.props.sym, 'Symbol(s)');
  assert.equal(app.props.nil, null);
  assert.deepEqual(app.props.tags, ['a', 1]);
  assert.deepEqual(app.hooks, ['typed', { open: true }]);
  assert.equal(app.state, null);
  const counter = reactPage({ op: 'inspect', id: idOf(f.counter) });
  assert.deepEqual(counter.state, { count: 2 });
  assert.deepEqual(counter.hooks, []);
  assert.deepEqual(counter.owners, ['App']);
  assert.equal(counter.source, null);
  assert.equal(reactPage({ op: 'inspect', id: idOf(f.app), secret: true }).props.title, '<4 chars>');
  assert.deepEqual(reactPage({ op: 'inspect', id: 9999 }), { missing: true });
});

test('the render hook counts each component that rendered per commit, alone or wrapping the page’s own hook', () => {
  page();
  renderHook();
  const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  assert.equal(hook.inject({}), 1);
  assert.equal(hook.inject({}), 2);
  hook.onCommitFiberUnmount();
  hook.onPostCommitFiberRoot();
  hook.checkDCE();
  const f = fibers();
  f.counter.actualDuration = 1.26;
  hook.onCommitFiberRoot(1, f.hostRoot.stateNode);
  // a second commit where only Counter changed: an unchanged fiber with an alternate does not count
  for (const x of [f.app, f.item, f.fwd]) x.alternate = { memoizedProps: x.memoizedProps, memoizedState: x.memoizedState };
  f.counter.alternate = { memoizedProps: {}, memoizedState: f.counter.memoizedState };
  hook.onCommitFiberRoot(1, f.hostRoot.stateNode);
  const r = reactPage({ op: 'renders' });
  assert.equal(r.installed, true);
  assert.equal(r.commits, 2);
  assert.deepEqual(r.components[0], { name: 'Counter!', count: 2, ms: 2.6 });
  assert.deepEqual(reactPage({ op: 'renders', maxNodes: 1 }).components.length, 1);
  // a page that has a hook keeps it working
  const win = page();
  const seen: any[] = [];
  win.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { onCommitFiberRoot: (...a: any[]) => (seen.push(a), 'own') };
  renderHook();
  assert.equal(win.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(7, fibers().hostRoot.stateNode), 'own');
  assert.equal(seen.length, 1);
  page();
  (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
  renderHook();
  assert.equal((window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, fibers().hostRoot.stateNode), undefined);
  page();
  assert.deepEqual(reactPage({ op: 'renders' }), { installed: false });
  // the sources are the functions, called as the page gets them
  assert.equal(REACT_SOURCE, `(${reactPage.toString()})`);
  assert.equal(RENDER_HOOK, `(${renderHook.toString()})();`);
});

/** The tool over a fake host whose tab answers reactPage's ops with `answers`. */
function tool(answers: Record<string, any>, o: { password?: boolean; fail?: any } = {}) {
  const sent: any[] = [];
  const tab: any = {
    id: 't1',
    send: async (method: string, params: any = {}) => {
      sent.push([method, params]);
      if (method === 'Runtime.evaluate' && params.expression.startsWith(REACT_SOURCE)) {
        if (o.fail) return { exceptionDetails: o.fail };
        const args = JSON.parse(params.expression.slice(REACT_SOURCE.length + 1, -1));
        return { result: { value: answers[args.op] } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: !!o.password } };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `s${sent.length}` };
      if (method === 'Page.removeScriptToEvaluateOnNewDocument' && o.fail === undefined && params.identifier === 'bad')
        throw new Error('gone');
      return {};
    },
  };
  const gates: string[] = [];
  const history: string[] = [];
  const tabs = {
    resolve: async () => tab,
    run: async (_t: any, fn: () => any) => fn(),
    ready: async () => {},
    history: async (_t: any, how: string) => history.push(how),
  };
  const run = reactTool({ tabs, pageGate: async (_t: any, need: string) => gates.push(need) });
  return { run: (args: any) => run(args, { chatId: 'c1' }), sent, gates, history, tab };
}

test('browser_react: tree, inspect and renders through the page world, with their gates and text', async () => {
  const t = tool({
    tree: { react: true, count: 3, lines: ['App [1]', '  Item [2]'] },
    inspect: { name: 'App', id: 1, source: 'App.tsx:3', owners: ['Root'], props: { a: 1 }, state: null, hooks: ['x'] },
    renders: {
      installed: true,
      commits: 4,
      components: [
        { name: 'App', count: 4, ms: 1.5 },
        { name: 'Item', count: 1, ms: 0 },
      ],
    },
  });
  assert.equal(
    await t.run({ action: 'tree' }),
    '3 components in t1; inspect one by its [id]:\nApp [1]\n  Item [2]\n… and 1 more (raise maxNodes)',
  );
  assert.equal(await t.run({ action: 'inspect', id: 1 }), 'App [1] at App.tsx:3, inside Root\nprops: {\n "a": 1\n}\nhooks: [\n "x"\n]');
  await assert.rejects(t.run({ action: 'inspect' }), /inspect needs the id/);
  assert.match(await t.run({ action: 'renders_start' }), /^Counting React renders in t1 \(the page reloaded/);
  assert.deepEqual(t.history, ['reload']);
  // a second start replaces the first hook
  await t.run({ action: 'renders_start' });
  assert.equal(t.sent.filter(([m]) => m === 'Page.removeScriptToEvaluateOnNewDocument').length, 1);
  assert.equal(await t.run({ action: 'renders_stop' }), '4 commits. Renders by component:\nApp: 4 (1.5 ms)\nItem: 1');
  assert.equal(t.sent.filter(([m]) => m === 'Page.removeScriptToEvaluateOnNewDocument').length, 2);
  assert.deepEqual(t.gates, ['read', 'read', 'read', 'write', 'write', 'read']);
  // the page world: no contextId, values only
  const evals = t.sent.filter(([m, p]) => m === 'Runtime.evaluate' && p.expression.startsWith(REACT_SOURCE));
  assert.ok(evals.every(([, p]) => p.contextId === undefined && p.returnByValue));
  await assert.rejects(t.run({ action: 'profile' }), /action must be "tree", "inspect", "renders_start" or "renders_stop"/);
});

test('browser_react: no React, a stale id, a sign-in page, nothing counted, and failures', async () => {
  const none = tool({ tree: { react: false, lines: [], count: 0 }, inspect: { missing: true }, renders: { installed: false } });
  assert.equal(await none.run({ action: 'tree' }), NO_REACT);
  await assert.rejects(none.run({ action: 'inspect', id: 5 }), /No component 5 on this page now/);
  assert.match(await none.run({ action: 'renders_stop' }), /^Not counting renders on this page/);
  const quiet = tool(
    {
      tree: { react: true, count: 1, lines: ['App [1]'] },
      inspect: { name: 'Form', id: 2, source: null, owners: [], props: {}, state: { v: '<3 chars>' }, hooks: [] },
      renders: { installed: true, commits: 2, components: [] },
    },
    { password: true },
  );
  assert.equal(await quiet.run({ action: 'tree' }), '1 components in t1; inspect one by its [id]:\nApp [1]');
  assert.equal(
    await quiet.run({ action: 'inspect', id: 2 }),
    'Form [2]\nprops: {}\nstate: {\n "v": "<3 chars>"\n}\nThis page has a password field: strings are shown as their length only.',
  );
  assert.equal(await quiet.run({ action: 'renders_stop' }), '2 commits, and no component rendered.');
  // a hook script that can't be removed is noted, not thrown
  const gone = tool({ renders: { installed: true, commits: 0, components: [] } });
  const hooks = { identifier: 'bad' };
  gone.tab.send = (
    (send) => async (m: string, p: any) =>
      m === 'Page.addScriptToEvaluateOnNewDocument'
        ? hooks
        : m === 'Page.removeScriptToEvaluateOnNewDocument'
          ? Promise.reject(new Error('gone'))
          : send(m, p)
  )(gone.tab.send);
  await gone.run({ action: 'renders_start' });
  await gone.run({ action: 'renders_start' });
  assert.equal(await gone.run({ action: 'renders_stop' }), '0 commits, and no component rendered.');
  const broken = tool({}, { fail: { exception: { description: 'TypeError: x' } } });
  await assert.rejects(broken.run({ action: 'tree' }), /Couldn't read React on this page: TypeError: x/);
  await assert.rejects(tool({}, { fail: { text: 'Uncaught' } }).run({ action: 'tree' }), /Couldn't read React on this page: Uncaught/);
  // an answer with no value reads as no React
  assert.deepEqual(await inPage({ send: async () => ({}) }, { op: 'tree' }), {});
});
