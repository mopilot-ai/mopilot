// The chat composer's props are held still while the chat screen draws for something else (#4986), and what they do is never out of date: each handler reads what the screen holds when it is called, so a plan that arrived, a send or a stop the screen changed since the composer last drew is the one used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot } from './support/phone/component-kit';

const hookPath = '../mobile/src/components/useThreadComposer';
const { useThreadComposer } = await import(hookPath);

type Over = Record<string, unknown>;
// state setters are the same functions for the life of a screen (React keeps them)
const setters = new WeakMap<
  string[],
  { setModelSheet: (open: string) => number; setAdding: (open: boolean) => number; setVoiceBusy: () => void }
>();
const settersOf = (calls: string[]) => {
  let own = setters.get(calls);
  if (!own)
    setters.set(
      calls,
      (own = {
        setModelSheet: (open) => calls.push(`sheet:${open}`),
        setAdding: (open) => calls.push(`add:${open}`),
        setVoiceBusy: () => undefined,
      }),
    );
  return own;
};
const inputs = (calls: string[], tag: string, over: Over = {}) => ({
  send: (skills: string[]) => (calls.push(`${tag}:send:${skills.join(',')}`), true),
  cards: {
    feedback: undefined as string | undefined,
    refusingFirst: (send: () => void) => () => (calls.push(`${tag}:refuse`), send()),
  },
  files: {
    items: [] as unknown[],
    ids: [] as string[],
    retry: (key: number) => calls.push(`${tag}:retry:${key}`),
    remove: (key: number) => calls.push(`${tag}:remove:${key}`),
  },
  settings: { controls: { model: 'm' } },
  media: undefined as unknown,
  running: false,
  busy: false,
  stopping: { stopping: false, stop: () => calls.push(`${tag}:stop`) },
  voiceBusy: false,
  ...settersOf(calls),
  ...over,
});

/** Draws the hook with new inputs each time, as the chat screen does, and hands back what it returned on each draw. */
async function draws(rounds: ((calls: string[]) => ReturnType<typeof inputs>)[], calls: string[]) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const seen: any[] = [];
  let index = 0;
  const Probe = () => {
    // the last draw of the round (React may draw twice)
    seen[index] = useThreadComposer(rounds[index](calls) as any);
    return null;
  };
  await act(async () => root.render(createElement(Probe)));
  for (index = 1; index < rounds.length; index += 1) await act(async () => root.render(createElement(Probe)));
  await act(async () => root.unmount());
  host.remove();
  return seen;
}

test('A: a redraw with new handler functions and the same data returns the same props, and each handler calls the newest function', async () => {
  const calls: string[] = [];
  const media = {};
  const items: unknown[] = [];
  const controls = { model: 'm' };
  const [first, second] = await draws(
    [
      (c) => inputs(c, 'old', { media, settings: { controls }, files: { ...inputs(c, 'old').files, items } }),
      (c) => inputs(c, 'new', { media, files: { ...inputs(c, 'new').files, items }, settings: { controls } }),
    ],
    calls,
  );
  for (const key of ['items', 'guard', 'send', 'stop', 'onVoiceBusy', 'bar', 'onAttach', 'tray'] as const)
    assert.equal(second[key], first[key], `${key} is the same`);
  second.send(['skill']);
  second.guard(() => calls.push('sent'))();
  second.stop();
  second.tray.props.retry(1);
  second.tray.props.remove(2);
  second.bar.props.open();
  second.onAttach();
  assert.deepEqual(calls.slice(calls.indexOf('new:send:skill')), [
    'new:send:skill',
    'new:refuse',
    'sent',
    'new:stop',
    'new:retry:1',
    'new:remove:2',
    'sheet:model',
    'add:true',
  ]);
});

test('B: what the pill and the strip show makes them again; no media means no strip and no + button; a plan asked about changes the field', async () => {
  const calls: string[] = [];
  const media = {};
  const items: unknown[] = [];
  const controls = { model: 'm' };
  const same = (x: string[], tag: string) => ({ media, settings: { controls }, files: { ...inputs(x, tag).files, items } });
  const [a, b, c, d] = await draws(
    [
      (x) => inputs(x, 'a', same(x, 'a')),
      (x) => inputs(x, 'b', { ...same(x, 'b'), settings: { controls: { model: 'other' } } }),
      (x) => inputs(x, 'c', { ...same(x, 'c'), files: { ...inputs(x, 'c').files, items: [{ key: 1 }], ids: ['f'] } }),
      (x) => inputs(x, 'd', { cards: { ...inputs(x, 'd').cards, feedback: 'comment' }, running: true, busy: true, voiceBusy: true }),
    ],
    calls,
  );
  assert.notEqual(b.bar, a.bar, 'another model, another pill');
  assert.equal(b.tray, a.tray, 'the strip is the same until its files change');
  assert.notEqual(c.tray, b.tray);
  assert.equal(c.attached, true);
  assert.equal(a.attached, false);
  assert.equal(a.tray === undefined || a.tray === null, false);
  assert.equal(d.focusKey, 'comment');
  assert.equal(d.autoFocus, true);
  assert.equal(d.running && d.stopDisabled && d.busy && d.menuOpen, true);
  const [bare] = await draws([(x) => inputs(x, 'z')], calls);
  assert.equal(bare.onAttach, undefined);
  assert.ok(!bare.tray, 'no media, no strip');
});
