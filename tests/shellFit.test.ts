// Side panels at the window's CSS width (src/lib/shellFit.ts, src/store/shellPanels.ts): a zoomed or narrow window
// hides the summary island, then the sidebar, never rewriting the user's choice; the user can still open either.
import { test, beforeEach } from 'node:test';
import './support/dom.ts';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';
import { SIDEBAR_MIN_WIDTH } from '../src/lib/sidebarSizing.ts';
import { CHAT_MIN_WIDTH, SUMMARY_SLOT_WIDTH } from '../src/lib/splitClamp.ts';

const { store, resetState } = await loadStore();
const { shellFit, panelShown, panelChange, forcedAfter } = await import('../src/lib/shellFit.ts');
const { showPanel, togglePanel, useShellFit } = await import('../src/store/shellPanels.ts');
const st = () => store.useStore.getState();

const BOTH = SIDEBAR_MIN_WIDTH + SUMMARY_SLOT_WIDTH + CHAT_MIN_WIDTH;
const SIDEBAR = SIDEBAR_MIN_WIDTH + CHAT_MIN_WIDTH;
const shown = () => true;

beforeEach(() => {
  resetState();
  resetAll();
});

test('the summary gives way first, then the sidebar, at the CSS widths a zoom leaves', () => {
  assert.deepEqual(shellFit(BOTH, shown), { sidebar: true, summary: true });
  assert.deepEqual(shellFit(BOTH - 1, shown), { sidebar: true, summary: false });
  assert.deepEqual(shellFit(SIDEBAR, shown), { sidebar: true, summary: false });
  assert.deepEqual(
    shellFit(SIDEBAR - 1, () => false),
    { sidebar: false, summary: false },
  );
  // a 1728 px window at 300% zoom: room for the chat and the sidebar, not the summary too
  assert.deepEqual(
    shellFit(1728 / 3, (fits) => fits),
    { sidebar: false, summary: false },
  );
  assert.deepEqual(
    shellFit(1024 / 1.2, (fits) => fits),
    { sidebar: true, summary: false },
  );
});

test('without the sidebar on screen the summary has its width back', () => {
  const asked: boolean[] = [];
  const width = SUMMARY_SLOT_WIDTH + CHAT_MIN_WIDTH;
  assert.deepEqual(
    shellFit(width, (fits) => (asked.push(fits), false)),
    { sidebar: true, summary: true },
  );
  assert.deepEqual(asked, [true], 'the sidebar is asked about with its own room');
  assert.equal(shellFit(width - 1, () => false).summary, false);
});

test('an unmeasured window fits both', () => {
  for (const w of [0, -1, Number.NaN]) assert.deepEqual(shellFit(w, shown), { sidebar: true, summary: true });
});

test('a panel shows when chosen and it fits, or when the user opened it at this width anyway', () => {
  const s = { sidebarOpen: true, summaryOpen: true, shellFit: { sidebar: true, summary: false }, shellForced: {} };
  assert.equal(panelShown(s, 'sidebar'), true);
  assert.equal(panelShown(s, 'summary'), false);
  assert.equal(panelShown({ ...s, shellForced: { summary: true } }, 'summary'), true);
  assert.equal(panelShown({ ...s, sidebarOpen: false }, 'sidebar'), false);
  assert.equal(panelShown({ ...s, summaryOpen: false, shellForced: { summary: true } }, 'summary'), false);
});

test("showing a panel that does not fit forces it; hiding sets the user's choice and drops the force", () => {
  const s = { sidebarOpen: true, summaryOpen: true, shellFit: { sidebar: true, summary: false }, shellForced: {} };
  assert.deepEqual(panelChange(s, 'summary', true), { summaryOpen: true, shellForced: { summary: true } });
  assert.deepEqual(panelChange(s, 'sidebar', true), { sidebarOpen: true, shellForced: { sidebar: false } });
  assert.deepEqual(panelChange({ ...s, shellForced: { summary: true } }, 'summary', false), {
    summaryOpen: false,
    shellForced: { summary: false },
  });
});

test('the controls act on what is on screen: a hidden summary opens on the first press, not the second', () => {
  store.useStore.setState({ summaryOpen: true, shellFit: { sidebar: true, summary: false } });
  togglePanel('summary');
  assert.equal(st().summaryOpen, true, 'the saved choice was already open and stays so');
  assert.equal(panelShown(st(), 'summary'), true);
  togglePanel('summary');
  assert.equal(st().summaryOpen, false);
  assert.equal(panelShown(st(), 'summary'), false);
  showPanel('sidebar', false);
  assert.equal(st().sidebarOpen, false);
  showPanel('sidebar', true);
  assert.deepEqual([st().sidebarOpen, st().shellForced.sidebar], [true, false]);
});

test('split view panes count beside the chat: the summary gives way to them too', () => {
  const split = 300;
  assert.deepEqual(shellFit(BOTH + split, shown, split), { sidebar: true, summary: true });
  assert.deepEqual(shellFit(BOTH + split - 1, shown, split), { sidebar: true, summary: false });
  assert.deepEqual(
    shellFit(SIDEBAR + split - 1, () => false, split),
    { sidebar: false, summary: false },
  );
});

test('a panel opened anyway is forgotten once it fits again, and the summary once the chat changes', () => {
  const forced = { sidebar: true, summary: true };
  const tight = { sidebar: false, summary: false };
  assert.equal(forcedAfter(forced, tight), forced, 'still tight: kept, the same object so nothing re-renders');
  assert.deepEqual(forcedAfter(forced, { sidebar: true, summary: false }), { sidebar: false, summary: true });
  assert.deepEqual(forcedAfter(forced, { sidebar: false, summary: true }), { sidebar: true, summary: false });
  assert.deepEqual(forcedAfter(forced, tight, true), { sidebar: true, summary: false }, "another chat's summary was not opened");
  const none = {};
  assert.equal(forcedAfter(none, tight, true), none);
});

test('the window keeps its room in the store: each change once, the sidebar counted as it shows', async () => {
  const Probe = ({ width, splits = 0, chat = 'a' }: { width: number; splits?: number; chat?: string }) => {
    useShellFit(width, splits, chat);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const draw = (width: number, chat = 'a', splits = 0) => act(async () => root.render(createElement(Probe, { width, chat, splits })));
  store.useStore.setState({ sidebarOpen: true, summaryOpen: true, shellForced: {} });
  const writes: unknown[] = [];
  const stop = store.useStore.subscribe((s: any, prev: any) => {
    if (s.shellFit !== prev.shellFit || s.shellForced !== prev.shellForced) writes.push([s.shellFit, s.shellForced]);
  });
  try {
    await draw(BOTH);
    assert.deepEqual(writes, [], 'nothing changes while both fit');
    await draw(BOTH - 1);
    assert.deepEqual(st().shellFit, { sidebar: true, summary: false }, 'the summary alone gives way');
    await draw(SIDEBAR - 1);
    assert.deepEqual(st().shellFit, { sidebar: false, summary: false });
    // the sidebar opened anyway where it does not fit: still counted, and kept while it does not fit
    store.useStore.setState({ shellForced: { sidebar: true } });
    await draw(SIDEBAR - 1);
    assert.deepEqual(st().shellFit, { sidebar: false, summary: false });
    assert.deepEqual(st().shellForced, { sidebar: true }, 'still tight: kept');
    // with the sidebar closed by the user, the summary has the width back
    store.useStore.setState({ sidebarOpen: false, shellForced: {} });
    await draw(SUMMARY_SLOT_WIDTH + CHAT_MIN_WIDTH, 'a');
    assert.deepEqual(st().shellFit, { sidebar: true, summary: true });
    // only what was opened anyway changes: another chat's summary was not
    store.useStore.setState({ sidebarOpen: true, shellForced: { summary: true } });
    await draw(SIDEBAR, 'a');
    const before = writes.length;
    await draw(SIDEBAR, 'b');
    assert.deepEqual(st().shellForced, { sidebar: false, summary: false });
    assert.equal(writes.length, before + 1);
    // split view panes count beside the chat
    await draw(BOTH, 'b', 1);
    assert.deepEqual(st().shellFit, { sidebar: true, summary: false });
  } finally {
    stop();
    await act(async () => root.unmount());
  }
});
