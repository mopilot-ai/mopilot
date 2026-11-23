// A message's GitHub PR link as a chip: its reference, then its state and title once read, kept current while the
// window is in use; no read while its run may still change, and a read for an earlier link never shows on a later one.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { act } from 'react';
import { mockStore, autoMock, render, callsTo, moduleCalls, window } from './support/thread-kit.ts';

mockStore();
autoMock('src/session/open.ts', 'open');

const reads: [string][] = [];
let respond: (url: string, fresh?: boolean) => Promise<unknown> = async () => null;
autoMock('src/session/pullRequestReader.ts', 'prr', {
  readPullRequest: Object.assign(() => null, { status: (url: string, fresh?: boolean) => (reads.push([url]), respond(url, fresh)) }),
});
const { PullRequestLink, REFRESH_MS } = await import('../src/components/markdown/PullRequestLink.tsx');
const { Markdown } = await import('../src/components/markdown/Markdown.tsx');
const { PullRequestReferenceTime } = await import('../src/components/markdown/prReferenceTime.ts');

const url = 'https://github.com/mopilot-ai/mopilot-internal/pull/1585';
const opened: unknown[] = [];
const chip = (props: Record<string, unknown> = {}) =>
  h(PullRequestLink, { url, href: `${url}#top`, live: true, onOpen: (e: unknown) => opened.push(e), ...props });
const flush = () => act(async () => {});

beforeEach(() => {
  reads.length = 0;
  opened.length = 0;
  moduleCalls.length = 0;
  respond = async (u) => ({ url: u, number: 1585, state: 'open', title: "fix: the app's own gh" });
});

for (const [state, label] of [
  ['open', 'open'],
  ['draft', 'draft'],
  ['merged', 'merged'],
  ['closed', 'closed'],
  ['unknown', 'status unavailable'],
] as const)
  test(`a ${state} PR shows its state icon, reference and title, and opens the link as written`, async () => {
    respond = async (u) => ({ url: u, number: 1585, state, title: state === 'unknown' ? undefined : 'Fix it' });
    const v = await render(chip());
    await flush();
    const a = v.$('a')!;
    assert.equal(a.className, `md-pr-chip ${state}`);
    assert.equal(a.getAttribute('href'), `${url}#top`);
    assert.equal(v.$('.md-pr-chip-ref')!.textContent, 'mopilot-ai/mopilot-internal#1585');
    assert.equal(v.$('.md-pr-chip-title')?.textContent, state === 'unknown' ? undefined : 'Fix it');
    assert.equal(a.textContent, `mopilot-ai/mopilot-internal#1585${state === 'unknown' ? '' : '·Fix it'}`);
    assert.equal(a.title, `${label} · ${url}#top`);
    assert.equal(
      a.getAttribute('aria-label'),
      `Pull request mopilot-ai/mopilot-internal#1585 · ${label}${state === 'unknown' ? '' : ' · Fix it'}`,
    );
    assert.ok(v.$('.md-pr-chip-icon svg'));
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => a.dispatchEvent(click as unknown as Event));
    assert.equal(click.defaultPrevented, true, 'the window never navigates');
    assert.equal(opened.length, 1);
    await v.unmount();
  });

test("the reference keeps the link's casing of owner and repository", async () => {
  const v = await render(chip({ href: 'https://github.com/MoPilot-AI/MoPilot-internal/pull/1585/' }));
  assert.equal(v.$('.md-pr-chip-ref')!.textContent, 'MoPilot-AI/MoPilot-internal#1585');
  await v.unmount();
});

test('a dated reply opens a moved PR with its original query and anchor, and a current reply keeps the reused name', async () => {
  const original = 'https://github.com/mopilot-ai/mopilot/pull/1';
  const moved = 'https://github.com/mopilot-ai/mopilot-internal/pull/1';
  const suffix = '?tab=files#discussion';
  const reusedAt = Date.parse('2026-11-21T23:34:53Z');
  const message = (completedAt: number) =>
    h(
      PullRequestReferenceTime.Provider,
      { value: completedAt },
      h(Markdown, { text: `Opened [PR #1](${original}${suffix}). [PR #1](${original})`, cwd: '/repo' }),
    );
  respond = async (u) => ({ url: u, number: 1, state: u === moved ? 'merged' : 'open' });
  const v = await render(message(reusedAt - 1_000));
  try {
    const link = () => v.$('a.md-pr-chip')!;
    assert.equal(link().getAttribute('href'), moved + suffix);
    assert.equal(v.$$('a.md-pr-chip')[1].getAttribute('href'), moved);
    assert.equal(link().className, 'md-pr-chip merged');
    await act(async () => link().click());
    assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), [moved + suffix, '/repo']);
    await v.rerender(message(reusedAt));
    assert.equal(link().getAttribute('href'), original + suffix);
    assert.equal(link().className, 'md-pr-chip open');
    assert.deepEqual(reads, [[moved], [moved], [original], [original]]);
  } finally {
    await v.unmount();
  }
});

test('an open PR shows its check health in the tooltip', async () => {
  respond = async (u) => ({
    url: u,
    number: 1585,
    state: 'open',
    details: { checks: 'failing', mergeable: 'MERGEABLE', mergeState: 'BLOCKED' },
  });
  const v = await render(chip());
  await flush();
  assert.match(v.$('a')!.title, /^open · checks failing · /);
  await v.unmount();
});

test('while its run may still change, the chip shows the reference without reading; it reads once live', async () => {
  const v = await render(chip({ live: false }));
  await flush();
  assert.deepEqual(reads, []);
  assert.equal(v.$('a')!.className, 'md-pr-chip loading');
  assert.equal(v.$('a')!.getAttribute('aria-label'), 'Pull request mopilot-ai/mopilot-internal#1585 · loading status');
  assert.equal(v.$('.md-pr-chip-title'), null);
  await v.rerender(chip({ live: true }));
  await flush();
  assert.deepEqual(reads, [[url]]);
  assert.equal(v.$('a')!.className, 'md-pr-chip open');
  await v.unmount();
});

test('a read for an earlier link never shows on a later one, and a failed read keeps what the chip showed', async () => {
  const pending: ((pr: unknown) => void)[] = [];
  respond = (u) => new Promise((resolve) => pending.push(() => resolve({ url: u, number: 1, state: 'merged', title: 'Old' })));
  const v = await render(chip());
  const next = 'https://github.com/org/repo/pull/7';
  respond = async (u) => ({ url: u, number: 7, state: 'closed', title: 'New' });
  await v.rerender(chip({ url: next, href: next }));
  await flush();
  await act(async () => pending[0](null));
  assert.equal(v.$('.md-pr-chip-ref')!.textContent, 'org/repo#7');
  assert.equal(v.$('.md-pr-chip-title')!.textContent, 'New');
  respond = async () => {
    throw new Error('gh failed');
  };
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(v.$('.md-pr-chip-title')!.textContent, 'New');
  await v.unmount();
});

test('the status is read again on focus and each minute while the window is visible, and not after unmount', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const visibility = Object.getOwnPropertyDescriptor(window.document, 'visibilityState');
  let hidden = false;
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  try {
    const v = await render(chip());
    await flush();
    await act(async () => mock.timers.tick(REFRESH_MS));
    assert.equal(reads.length, 2, 'mount and the visible minute');
    hidden = true;
    await act(async () => mock.timers.tick(REFRESH_MS));
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.equal(reads.length, 2, 'a hidden window reads nothing');
    hidden = false;
    await act(async () => window.document.dispatchEvent(new window.Event('visibilitychange')));
    assert.equal(reads.length, 3, 'showing the window reads once');
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.equal(reads.length, 4);
    await v.unmount();
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await act(async () => mock.timers.tick(REFRESH_MS));
    assert.equal(reads.length, 4);
  } finally {
    mock.timers.reset();
    if (visibility) Object.defineProperty(window.document, 'visibilityState', visibility);
    else delete (window.document as any).visibilityState;
  }
});

test('a shown chip and a focused window bypass settled open and unavailable statuses without waiting a minute', async () => {
  const { createPullRequestReader } = await import('../src/lib/threadPullRequest.ts');
  for (const initial of ['OPEN', 'unknown']) {
    let state = initial;
    const reader = createPullRequestReader({
      attachments: async () => ({ data: [], nextCursor: null }),
      legacy: async () => null,
      head: async () => null,
      gh: async (requested) => ({ ok: state !== 'unknown', stdout: JSON.stringify({ url: requested, state }) }),
    });
    await reader.status(url);
    state = 'CLOSED';
    respond = (u, fresh) => reader.status(u, fresh);
    const v = await render(chip());
    try {
      assert.equal(v.$('a')!.className, 'md-pr-chip closed');
      state = 'MERGED';
      await act(async () => window.dispatchEvent(new window.Event('focus')));
      assert.equal(v.$('a')!.className, 'md-pr-chip merged');
    } finally {
      await v.unmount();
    }
  }
});

test('refreshes during a slow read coalesce into a follow-up and cannot publish the superseded answer', async () => {
  const { controlledReads } = await import('./support/async-scenarios.ts');
  const pending = controlledReads<unknown>();
  respond = pending.read;
  const v = await render(chip());
  try {
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.equal(pending.requests.length, 1, 'an in-flight read owns its follow-up');
    await act(async () => pending.requests[0].resolve({ url, number: 1585, state: 'open' }));
    assert.equal(pending.requests.length, 2);
    assert.equal(v.$('a')!.className, 'md-pr-chip loading', 'the obsolete answer cannot flash');
    await act(async () => pending.requests[1].resolve({ url, number: 1585, state: 'merged' }));
    assert.equal(v.$('a')!.className, 'md-pr-chip merged');
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await v.unmount();
    await act(async () => pending.requests[2].reject(new Error('late failure')));
    assert.equal(pending.requests.length, 3, 'unmount retires the queued follow-up');
  } finally {
    if (v.host.isConnected) await v.unmount();
  }
});

test('a shared poll callback already queued when another listener unmounts the chip starts no retired read', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { visiblePoll } = await import('../src/lib/visiblePoll.ts');
  let v: Awaited<ReturnType<typeof render>>;
  const stop = visiblePoll('pull-request-chip', REFRESH_MS, () => void v.unmount(), { wake: false });
  try {
    v = await render(chip());
    await act(async () => t.mock.timers.tick(REFRESH_MS));
    assert.equal(reads.length, 1, 'the scheduler snapshot still holds the retired callback after its sibling unmounted it');
  } finally {
    stop();
  }
});
