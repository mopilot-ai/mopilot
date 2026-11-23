// A chat's whole PR list (src/components/thread/usePrInbox.ts `all`, src/components/thread/PrInbox.tsx,
// src/components/thread/prLine.ts): every PR the family's histories name, of any date, on any harness, each once under its
// most specific chat, and a tray that stays open while the status line's count moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  store,
  kit,
  rows,
  prs,
  listed,
  listedReads,
  monitors,
  lastAnswers,
  ComposerPills,
  Inbox,
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
} from './support/prInboxUIKit.ts';

const merged = (n: number, mergedAt: number | undefined = Date.now() - n * 1000) =>
  open({ url: url(n), number: n, state: 'merged', title: `PR ${n}`, mergedAt });
const threads = (...ids: string[]) =>
  store.setState({ threads: Object.fromEntries(ids.map((id) => [id, { id, updatedAt: 1, name: id }])) });
const count = (v: any) => v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement | null;
const session = (t: Element, title: string) => text(button(t, title)!.parentElement!.querySelector('[class*="meta"]'));

test('a chat with no session lists its own PRs, older merges included', async () => {
  reset();
  threads('top');
  listed.top = [merged(1, 1000), open({ url: url(2), number: 2, title: 'PR 2' })];
  await show({});
  const v = await render(h(Inbox, { threadId: 'top' }));
  await settle();
  assert.equal(text(count(v)), '1 merged PR · 1 open PR');
  await click(count(v)!);
  assert.equal(session(tray()!, 'PR 1'), '#1·this chat');
  await v.unmount();
});

test('each PR shows once under its most specific chat, and only a tracked PR carries its session question', async () => {
  reset();
  threads('top', 'ask', 'grand');
  rows.ask = 'input';
  // the session's own branch PR, which the parent's reply and another PR of the same session also name
  prs[url(1)] = open({ url: url(1), number: 1, title: 'Tracked' });
  listed.top = [merged(9), open({ url: url(1), number: 1, title: 'Tracked' }), merged(8)];
  listed.ask = [open({ url: url(1), number: 1, title: 'Tracked' }), open({ url: url(3), number: 3, title: 'Other of ask' }), merged(8)];
  listed.grand = [merged(9)];
  const children = { ask: child({ name: 'ask', ...facts(1) }), grand: child({ parentId: 'ask', name: 'grand', createdAt: 2 }) };
  const wrapUps = { ask: { recap: 'r', ask: 'Ship?', actions: [] } };
  await show(children, { wrapUps });
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children, { wrapUps });
  assert.equal(text(count(v)), '2 merged PRs · 2 open PRs');
  await click(count(v)!);
  const t = tray()!;
  assert.equal(session(t, 'Tracked'), '#1·ask');
  assert.equal(session(t, 'Other of ask'), '#3·ask');
  // the deepest chat naming a merge owns it, not the parent reporting it
  assert.equal(session(t, 'PR 9'), '#9·grand');
  assert.equal(session(t, 'PR 8'), '#8·ask');
  assert.equal(t.querySelectorAll('[data-group="needs"]').length, 1);
  assert.ok(button(t, 'Tracked')!.closest('[data-group="needs"]'));
  await v.unmount();
});

test('five merges show, the rest behind Show N more; a merge of unknown date says merged', async () => {
  reset();
  threads('top');
  listed.top = [1, 2, 3, 4, 5, 6].map((n) => merged(n)).concat(merged(7, undefined as never));
  listed.top[6] = open({ url: url(7), number: 7, state: 'merged', title: 'PR 7' });
  await show({});
  const v = await render(h(Inbox, { threadId: 'top' }));
  await settle();
  await click(count(v)!);
  const titles = () => [...tray()!.querySelectorAll('section[aria-label="Merged"] button[title*="Open #"]')].map((b) => b.textContent);
  assert.deepEqual(titles(), ['PR 1', 'PR 2', 'PR 3', 'PR 4', 'PR 5']);
  await click(button(tray()!, 'Show 2 more')!);
  assert.deepEqual(titles(), ['PR 1', 'PR 2', 'PR 3', 'PR 4', 'PR 5', 'PR 6', 'PR 7']);
  assert.equal(button(tray()!, 'Show 2 more'), undefined);
  assert.match(text(button(tray()!, 'PR 7')!.parentElement)!, /#7·this chatMerged$/);
  await v.unmount();
});

test('the list reads each chat the window knows, keeps its last answer through a failure, and drops late reads', async () => {
  reset();
  threads('top');
  listed.top = [merged(1)];
  listed.gone = [merged(2)];
  const children = { gone: child({ name: 'gone' }) };
  await show(children);
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children);
  // no thread record, no history to read: its tracked PR would still show
  assert.deepEqual(listedReads, ['top']);
  assert.equal(text(count(v)), '1 merged PR');
  // a read that failed leaves the list; the same answer again changes nothing
  listed.top = new Error('offline');
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await settle();
  assert.equal(text(count(v)), '1 merged PR');
  listed.top = [merged(1)];
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await settle();
  assert.equal(text(count(v)), '1 merged PR');
  // a PR GitHub can't answer for now keeps its last full answer
  listed.top = [{ url: url(1), number: 1, state: 'unknown' }];
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await settle();
  assert.equal(text(count(v)), '1 merged PR');
  await v.unmount();

  // mounting again starts from the last list, before any read settles, so the count doesn't flash
  let release: (v?: unknown) => void = () => {};
  kit.listedGate = new Promise((r) => (release = r));
  const again = await render(h(Inbox, { threadId: 'top' }));
  await act(async () => {});
  assert.equal(text(count(again)), '1 merged PR');
  listed.top = [merged(1), merged(5)];
  await again.unmount();
  // this read settles after it went: nothing to update
  await act(async () => release());
  await settle();
  assert.ok(lastAnswers.has(url(5)));
});

test('with GitHub unreadable, old PRs only named do not read as open; a tracked PR still says so', async () => {
  reset();
  threads('top');
  prs[url(1)] = { url: url(1), number: 1, state: 'unknown' };
  listed.top = [
    { url: url(2), number: 2, state: 'unknown' },
    // a reply said it opened, and GitHub could not confirm it
    { url: url(3), number: 3, state: 'open', source: 'response' },
    { url: url(4), number: 4, state: 'closed' },
    { url: url(5), number: 5, state: 'merged', source: 'response' },
  ];
  const children = { a: child({ name: 'a', ...facts(1) }) };
  await show(children);
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children);
  assert.equal(text(count(v)), '1 merged PR · 1 open PR');
  await click(count(v)!);
  assert.match(text(tray())!, /Status unavailable/);
  assert.doesNotMatch(text(tray())!, /#2|#3|#4/);
  await v.unmount();
});

test('a line drawing the count twice keeps one that works when either goes', async () => {
  reset();
  threads('top');
  listed.top = [merged(1)];
  await show({});
  const view = (first: boolean, second: boolean) =>
    h(
      'div',
      null,
      h(ComposerPills, { threadId: 'top', showGoal: false, showInbox: true }),
      first && h('div', { key: 'first', id: 'first' }, h(PrCount, { chatId: 'top' })),
      second && h('div', { key: 'second', id: 'second' }, h(PrCount, { chatId: 'top' })),
    );
  const v = await render(view(true, true));
  await settle();
  // the anchor (the last attached) stays when the earlier one goes
  await v.rerender(view(false, true));
  await click(v.host.querySelector('#second button') as HTMLButtonElement);
  assert.ok(tray());
  await click(v.host.querySelector('#second button') as HTMLButtonElement);
  // the anchor itself goes: clicking the other one opens there
  await v.rerender(view(true, true));
  await v.rerender(view(true, false));
  assert.equal(tray(), null);
  await click(v.host.querySelector('#first button') as HTMLButtonElement);
  assert.ok(tray());
  await v.unmount();
});

test('the tray stays open with its state while the count moves to another line, and hides while no count shows', async () => {
  reset();
  threads('top');
  rows.a = 'input';
  prs[url(1)] = open({ url: url(1), number: 1, title: 'PR 1' });
  monitors.top = null;
  const children = { a: child({ name: 'a', ...facts(1) }) };
  const wrapUps = { a: { recap: 'r', ask: 'Ship?', actions: [{ label: 'Ship', message: null }] } };
  const view = (where: 'running' | 'after' | 'none') =>
    h(
      'div',
      null,
      h(ComposerPills, { threadId: 'top', showGoal: false, showInbox: true }),
      where !== 'none' && h('div', { key: where, id: where }, h(PrCount, { chatId: 'top' })),
    );
  await show(children, { wrapUps });
  const v = await render(view('running'));
  await show(children, { wrapUps });
  await click(v.host.querySelector('#running button') as HTMLButtonElement);
  await click(button(tray()!, 'Ship')!);
  assert.match(text(tray())!, /Sent/);
  // the turn ended: the running line's count went and the line after the turn has its own
  await v.rerender(view('after'));
  await settle();
  const moved = v.host.querySelector('#after button') as HTMLButtonElement;
  assert.equal(moved.getAttribute('aria-expanded'), 'true');
  assert.match(text(tray())!, /Sent/);
  // nothing to anchor to: no tray, and it returns with the count
  await v.rerender(view('none'));
  await settle();
  assert.equal(tray(), null);
  await v.rerender(view('after'));
  await settle();
  assert.ok(tray());
  // closing gives the keyboard back to the count
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const after = v.host.querySelector('#after button') as HTMLButtonElement;
  assert.equal(after.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, after);
  await click(after);
  await v.unmount();
  // the chat left the screen: its count and tray went with it
  const next = await render(h(PrCount, { chatId: 'top' }));
  assert.equal(next.host.innerHTML, '');
  await next.unmount();
});
