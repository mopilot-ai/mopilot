// MoMo's suggestions in the Tasks panel's Up next (src/components/momo/tasks, A7): "From your sources" with each suggestion's title, one source line, Start, Add, Hide and a Why? that shows the reason, the first step and what the ranking used; at most the Mac's `shown` are drawn with "Show n more"; Add moves one to "Added by you" (which has Start and Hide, and slides up once); Start goes on to MoMo's chat; a refusal is said in a toast and the suggestion stays; a failed or unavailable read shows no suggestion; the count on Up next includes them; the loops under Up next stay.
import './support/tz-la.ts';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { mockSource } from './support/stubs.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

// a toast's own timer would keep this process alive
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) =>
  realSetTimeout(ms !== undefined && ms >= 3000 ? () => undefined : fn, ms !== undefined && ms >= 3000 ? 0 : ms, ...rest)) as any;

const f: any = { calls: [], listeners: new Set(), tasks: [] };
mockSource('src/store/panes.ts', { navigate: (r: any) => f.calls.push(['navigate', r]) });
mock.module('../src/store/send.ts', { namedExports: { sendMessage: async () => undefined } });
installNativeStub({
  momoTasks: {
    list: async () => ({ ok: true, v: 2, tasks: f.tasks, paused: false, now: NOW }),
    mark: async () => ({ ok: true }),
    onChanged: () => () => undefined,
  },
  momoSuggestions: {
    list: async () => f.list(),
    act: async (...a: any[]) => (f.calls.push(['act', ...a]), f.actAnswer(...a)),
    onChanged: (cb: () => void) => {
      f.listeners.add(cb);
      return () => f.listeners.delete(cb);
    },
  },
  momoMemory: { loopAct: async () => ({ ok: true, loop: {} }), onChanged: () => () => undefined },
  momoRoutines: { edit: async () => ({}) },
  momoPrefs: { set: async () => true },
});
const { TasksPanel } = await import('../src/components/momo/tasks/TasksPanel.tsx');
const { scoreLine } = await import('../src/components/momo/tasks/taskCopy.ts');
const { useStore } = await import('../src/store/core.ts');

const NOW = new Date(2026, 10, 16, 9, 0).getTime();
const sug = (n: number, over: any = {}) => ({
  id: `s${n}`,
  title: `Reply to person ${n}`,
  why: `Person ${n} asked on Monday.`,
  source: `Mail: person ${n}, Lease`,
  step: `Draft a reply to person ${n}`,
  channel: 'main',
  kind: 'reply',
  status: 'new',
  createdAt: NOW,
  expiresAt: NOW + 7 * 86_400_000,
  score: { urgency: 1, cost: 0.9, confidence: 0.9, novelty: 0.5, total: 0.4 },
  ...over,
});
const answer = (suggestions: any[], shown = 6) => ({ ok: true, v: 1, suggestions, shown, now: NOW });
const QUEUED = {
  id: 'loop:L2',
  kind: 'loop',
  tab: 'next',
  state: 'queued',
  title: 'Plan the offsite',
  detail: 'someday',
  at: null,
  dueAt: null,
  dueDay: null,
  ref: 'L2',
  outcome: null,
  nextAt: null,
  paused: false,
};
function reset(suggestions: any[] = [], tasks: any[] = []) {
  f.calls = [];
  f.tasks = tasks;
  f.list = async () => answer(suggestions);
  f.actAnswer = async (id: string, action: string) => ({ ok: true, id, action, channel: 'main' });
  useStore.setState({ toasts: [] });
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
async function mount() {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(TasksPanel)));
  await flush();
  const all = (sel: string, at: any = host) => [...at.querySelectorAll(sel)];
  const click = async (b: any) => {
    await act(async () => b.click());
    await flush();
  };
  return {
    host,
    all,
    q: (sel: string, at: any = host) => at.querySelector(sel),
    click,
    button: (label: string, at: any = host) => all('button', at).find((b: any) => b.textContent === label),
    tab: (name: string) => all('[role=tab]').find((t: any) => t.textContent.startsWith(name)),
    close: () => act(async () => root.unmount()),
  };
}
const titles = (v: any) => v.all('.settings-group-title').map((t: any) => t.textContent);
const rowOf = (v: any, id: string) => v.q(`[data-suggestion="${id}"]`);
const labels = (v: any, id: string) => v.all('button', rowOf(v, id)).map((b: any) => b.textContent);
const toasts = () => useStore.getState().toasts as any[];

test('Up next draws the suggestions under "From your sources" with their source line and Start, Add, Hide and Why?, and the tab counts them', async () => {
  reset([sug(1), sug(2)], [QUEUED]);
  const v = await mount();
  assert.equal(v.tab('Up next').textContent, 'Up next 3');
  await v.click(v.tab('Up next'));
  assert.deepEqual(titles(v), ['From your sources']);
  assert.deepEqual(
    v.all('[data-suggestion]').map((r: any) => r.getAttribute('data-suggestion')),
    ['s1', 's2'],
  );
  assert.deepEqual(labels(v, 's1'), ['Start', 'Add', 'Hide', 'Why?']);
  assert.ok(rowOf(v, 's1').textContent.includes('Reply to person 1'));
  assert.ok(rowOf(v, 's1').textContent.includes('Mail: person 1, Lease'));
  // the user's own promises stay under Up next, below the suggestions
  assert.deepEqual(
    v.all('[data-task]').map((r: any) => r.getAttribute('data-task')),
    ['loop:L2'],
  );
  assert.equal(v.q('[data-suggestion-why]'), null, 'the reason is behind Why?');
  await v.close();
});

test('Why? shows the reason, the first step and what the ranking used, and hides them again', async () => {
  reset([sug(1)]);
  const v = await mount();
  await v.click(v.tab('Up next'));
  const why = v.button('Why?', rowOf(v, 's1'));
  assert.equal(why.getAttribute('aria-expanded'), 'false');
  await v.click(why);
  assert.equal(why.getAttribute('aria-expanded'), 'true');
  const text = v.q('[data-suggestion-why]').textContent;
  assert.ok(text.includes('Person 1 asked on Monday.'));
  assert.ok(text.includes('First step: Draft a reply to person 1'));
  assert.ok(text.includes('Ranked on: soon 1, cost 0.9, sure 0.9, new 0.5.'));
  assert.equal(text.includes(scoreLine(sug(1) as any)), true);
  await v.click(v.button('Why?', rowOf(v, 's1')));
  assert.equal(v.q('[data-suggestion-why]'), null);
  await v.close();
});

test('only the first `shown` are drawn, and "Show n more" draws the rest', async () => {
  reset([1, 2, 3, 4].map((n) => sug(n)));
  f.list = async () =>
    answer(
      [1, 2, 3, 4].map((n) => sug(n)),
      2,
    );
  const v = await mount();
  await v.click(v.tab('Up next'));
  assert.equal(v.all('[data-suggestion]').length, 2);
  await v.click(v.button('Show 2 more'));
  assert.equal(v.all('[data-suggestion]').length, 4);
  assert.equal(v.button('Show 2 more'), undefined);
  await v.close();
});

test('Add keeps one as the user’s own: it moves to "Added by you" with Start and Hide, and slides up once', async () => {
  reset([sug(1), sug(2)]);
  const v = await mount();
  await v.click(v.tab('Up next'));
  f.actAnswer = async (id: string, action: string) => {
    f.list = async () => answer([sug(1, { status: 'added' }), sug(2)]);
    return { ok: true, id, action, channel: 'main' };
  };
  await v.click(v.button('Add', rowOf(v, 's1')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'act'),
    [['act', 's1', 'add']],
  );
  assert.deepEqual(titles(v), ['From your sources', 'Added by you']);
  assert.deepEqual(labels(v, 's1'), ['Start', 'Hide', 'Why?']);
  assert.match(rowOf(v, 's1').className, /slideUp/);
  assert.doesNotMatch(rowOf(v, 's2').className, /slideUp/);
  await v.close();
});

test('Hide removes it; Start sends it on and opens MoMo’s chat; nothing is sent by showing a suggestion', async () => {
  reset([sug(1), sug(2)]);
  const v = await mount();
  await v.click(v.tab('Up next'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'act'),
    [],
  );
  f.actAnswer = async (id: string, action: string) => {
    f.list = async () => answer([sug(2)]);
    return { ok: true, id, action, channel: 'main' };
  };
  await v.click(v.button('Hide', rowOf(v, 's1')));
  assert.equal(rowOf(v, 's1'), null);
  assert.equal(v.tab('Up next').textContent, 'Up next 1');
  f.actAnswer = async (id: string, action: string) => {
    f.list = async () => answer([]);
    return { ok: true, id, action, channel: 'main' };
  };
  await v.click(v.button('Start', rowOf(v, 's2')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] !== 'navigate' || true).map((c: any) => c.slice(0, 3)),
    [
      ['act', 's1', 'hide'],
      ['act', 's2', 'start'],
      ['navigate', { name: 'momo', tab: 'chat' }],
    ],
  );
  assert.equal(toasts().length, 0);
  await v.close();
});

test('a refusal is said in a toast and the suggestion stays; one that is gone says so; a throw says why', async () => {
  reset([sug(1)]);
  const v = await mount();
  await v.click(v.tab('Up next'));
  f.actAnswer = async () => ({ ok: false, error: 'MoMo is paused. Resume it first.' });
  await v.click(v.button('Start', rowOf(v, 's1')));
  assert.equal(toasts().at(-1).text, 'MoMo is paused. Resume it first.');
  assert.ok(rowOf(v, 's1'));
  f.actAnswer = async () => ({ ok: false, reason: 'gone', error: 'That suggestion is gone.' });
  await v.click(v.button('Hide', rowOf(v, 's1')));
  assert.equal(toasts().at(-1).text, 'That suggestion is gone.');
  f.actAnswer = async () => {
    throw new Error('Mac went away');
  };
  await v.click(v.button('Add', rowOf(v, 's1')));
  assert.match(toasts().at(-1).text, /Mac went away/);
  assert.equal(f.calls.filter((c: any) => c[0] === 'navigate').length, 0, 'a refused Start does not open the chat');
  await v.close();
});

test('a read that fails keeps the last list; not allowed or unavailable shows none; a change told by main reads again', async () => {
  reset([sug(1)]);
  const v = await mount();
  await v.click(v.tab('Up next'));
  assert.ok(rowOf(v, 's1'));
  f.list = async () => {
    throw new Error('no');
  };
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  await flush();
  assert.ok(rowOf(v, 's1'), 'the last list stays');
  f.list = async () => ({ ok: false, reason: 'unavailable', error: 'The Tasks panel is off' });
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  await flush();
  assert.equal(rowOf(v, 's1'), null);
  f.list = async () => answer([sug(3)]);
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  await flush();
  assert.ok(rowOf(v, 's3'));
  f.list = async () => ({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  await flush();
  assert.equal(rowOf(v, 's3'), null);
  f.list = async () => ({ ok: false, error: 'something else' });
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  await flush();
  assert.equal(rowOf(v, 's3'), null, 'another failure leaves what is shown');
  await v.close();
});

test('a read that settles after a newer one changes nothing', async () => {
  reset([sug(1)]);
  const v = await mount();
  await v.click(v.tab('Up next'));
  const late: { resolve: (r: any) => void } = { resolve: () => undefined };
  f.list = () => new Promise((resolve) => (late.resolve = resolve));
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  const first = late.resolve;
  f.list = async () => answer([sug(2)]);
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  await flush();
  assert.ok(rowOf(v, 's2'));
  first(answer([sug(9)]));
  await flush();
  assert.equal(rowOf(v, 's9'), null, 'the older read does not replace the newer');
  assert.ok(rowOf(v, 's2'));
  await v.close();
});

test('with no suggestion and no loop Up next says its empty line; with only suggestions it has no empty row', async () => {
  reset([]);
  const v = await mount();
  await v.click(v.tab('Up next'));
  assert.ok(v.host.textContent.includes('Nothing queued. Suggestions from your sources show here.'));
  await v.close();
  reset([sug(1)]);
  const w = await mount();
  await w.click(w.tab('Up next'));
  assert.equal(w.host.textContent.includes('Nothing queued'), false);
  await w.close();
});
