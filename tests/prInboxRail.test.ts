// The shared PR rail through its real inbox owner: Claude Code's rows instead of a transcript count, on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  store,
  listed,
  prs,
  ComposerPills,
  PrCount,
  url,
  open,
  child,
  facts,
  settle,
  show,
  tray,
  text,
  button,
  reset,
  act,
  h,
  render,
  click,
  links,
} from './support/prInboxUIKit.ts';

const rail = (v: any) => v.host.querySelector('[aria-label="Chat pull requests"]') as HTMLElement | null;
const entries = (v: any) => [...rail(v)!.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open pull request #"]')];
const merged = (n: number) => open({ url: url(n), number: n, title: `Fix ${n}`, state: 'merged', mergedAt: n });
const owner = (id: string) =>
  h('div', { key: id }, h(ComposerPills, { threadId: id, showGoal: false, showInbox: true }), h(PrCount, { chatId: id }));

for (const id of ['codex-chat', 'claude:chat', 'acp:agent:chat']) {
  test(`${id}: a lone merged PR shows its icon, number and title and opens GitHub`, async () => {
    reset();
    store.setState({ threads: { [id]: { id, updatedAt: 1 } } });
    listed[id] = [merged(1)];
    await show({});
    const v = await render(owner(id));
    await settle();
    assert.ok(rail(v), 'a PR is a rail row, not an orphan count beneath the reply');
    assert.equal(v.host.querySelector('.tasks-count'), null);
    assert.equal(entries(v).length, 1);
    assert.equal(text(entries(v)[0]), '#1Fix 1');
    assert.ok(entries(v)[0].querySelector('[data-state="merged"] svg'));
    assert.equal(button(rail(v)!, '1 earlier pull request'), undefined);
    await click(entries(v)[0]);
    assert.deepEqual(links, [url(1)]);
    await click(rail(v)!.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement);
    assert.ok(tray(), 'the existing detailed tray stays reachable');
    await v.unmount();
  });
}

test('mixed PRs fold earlier merges, deduplicate repeated reports and retain the tray during live/completed updates', async () => {
  reset();
  store.setState({ threads: { top: { id: 'top', updatedAt: 1 }, a: { id: 'a', updatedAt: 1 } } });
  listed.top = [merged(1), merged(2)];
  listed.a = [merged(1)];
  prs[url(3)] = open({ url: url(3), number: 3, title: 'Still working' });
  const children = { a: child({ name: 'worker', ...facts(3) }) };
  await show(children);
  const v = await render(owner('top'));
  await show(children);
  assert.ok(rail(v));
  assert.deepEqual(entries(v).map(text), ['#3Still working']);
  const earlier = rail(v)!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]:not([aria-haspopup])')!;
  assert.equal(text(earlier), '2 earlier pull requests2 merged');
  await click(earlier);
  assert.deepEqual(entries(v).map(text), ['#3Still working', '#2Fix 2', '#1Fix 1']);
  await click(earlier);
  const summary = rail(v)!.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
  await click(summary);
  assert.ok(tray());
  prs[url(3)] = merged(3);
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await settle();
  assert.deepEqual(entries(v).map(text), ['#3Fix 3', '#2Fix 2', '#1Fix 1']);
  assert.ok(tray(), 'a PR landing does not discard the open tray');
  assert.equal(summary.getAttribute('aria-label'), 'Pull requests: 3 merged');
  await v.unmount();
});

test('a long rail initially shows five rows, expands and folds, and resets when the chat changes', async () => {
  reset();
  store.setState({ threads: { top: { id: 'top', updatedAt: 1 }, next: { id: 'next', updatedAt: 1 } } });
  listed.top = Array.from({ length: 7 }, (_, i) => merged(i + 1));
  listed.next = [merged(8)];
  await show({});
  const v = await render(owner('top'));
  await settle();
  assert.ok(rail(v));
  assert.equal(entries(v).length, 5);
  await click(button(rail(v)!, 'Show 2 more')!);
  assert.equal(entries(v).length, 7);
  await click(button(rail(v)!, 'Show less')!);
  assert.equal(entries(v).length, 5);
  await v.rerender(owner('next'));
  await settle();
  assert.deepEqual(entries(v).map(text), ['#8Fix 8']);
  assert.equal(button(rail(v)!, 'Show less'), undefined);
  await v.unmount();
});

test('an unknown tracked PR keeps its number with an honest state and an empty inbox draws no rail', async () => {
  reset();
  prs[url(9)] = { url: url(9), number: 9, state: 'unknown' };
  const children = { a: child(facts(9)) };
  await show(children);
  const v = await render(owner('top'));
  await show(children);
  assert.ok(rail(v));
  assert.match(entries(v)[0].getAttribute('title')!, /status unavailable/i);
  assert.equal(text(entries(v)[0]), '#9Pull request #9');
  await show({});
  assert.equal(rail(v), null);
  await v.unmount();
});

test('title/state changes with the same count reach the rail, and reported or pending data stays honest', async () => {
  reset();
  const children = { a: child(facts(9)) };
  await show(children);
  const v = await render(owner('top'));
  await show(children);
  assert.match(entries(v)[0].getAttribute('title')!, /status unavailable/i);
  prs[url(9)] = open({ url: url(9), number: 9, title: 'First title' });
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await settle();
  assert.equal(text(entries(v)[0]), '#9First title');
  prs[url(9)] = open({ url: url(9), number: 9, title: 'Revised title', state: 'draft', source: 'response' });
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await settle();
  assert.equal(text(entries(v)[0]), '#9Revised title');
  assert.match(entries(v)[0].getAttribute('title')!, /reported draft/);
  assert.ok(entries(v)[0].querySelector('[data-state="draft"] svg'));
  await v.unmount();
});

test('one earlier merge uses singular copy beside an open PR and opens its row', async () => {
  reset();
  store.setState({ threads: { top: { id: 'top', updatedAt: 1 } } });
  listed.top = [merged(1), open({ url: url(2), number: 2, title: '' })];
  await show({});
  const v = await render(owner('top'));
  await settle();
  assert.equal(text(entries(v)[0]), '#2Pull request #2');
  const earlier = rail(v)!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]:not([aria-haspopup])')!;
  assert.equal(text(earlier), '1 earlier pull request1 merged');
  await click(earlier);
  await click(entries(v)[1]);
  assert.deepEqual(links, [url(1)]);
  await v.unmount();
});

test('a list that stops folding forgets its expansion before more PRs arrive', async (t) => {
  reset();
  store.setState({ threads: { top: { id: 'top', updatedAt: 1 } } });
  const many = Array.from({ length: 7 }, (_, i) => merged(i + 1));
  listed.top = many;
  await show({});
  const v = await render(owner('top'));
  t.after(() => v.unmount());
  await settle();
  await click(button(rail(v)!, 'Show 2 more')!);
  assert.equal(entries(v).length, 7);
  const refresh = async (items: any[]) => {
    listed.top = items;
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await settle();
  };
  await refresh([many[0]]);
  assert.equal(entries(v).length, 1);
  await refresh(many);
  assert.equal(entries(v).length, 5, 'a newly long list starts folded');
});

test('earlier merges that disappear and return start folded', async (t) => {
  reset();
  store.setState({ threads: { top: { id: 'top', updatedAt: 1 } } });
  listed.top = [merged(1)];
  prs[url(2)] = open({ url: url(2), number: 2, title: 'Open' });
  const children = { a: child(facts(2)) };
  await show(children);
  const v = await render(owner('top'));
  t.after(() => v.unmount());
  await show(children);
  const earlier = () => rail(v)!.querySelector<HTMLButtonElement>('button[aria-expanded]:not([aria-haspopup])')!;
  await click(earlier());
  assert.equal(entries(v).length, 2);
  await show({});
  assert.equal(entries(v).length, 1, 'merged rows become current when nothing is open');
  await show(children);
  assert.equal(earlier().getAttribute('aria-expanded'), 'false');
  assert.equal(entries(v).length, 1);
});
