// The production sidebar row passes its own element to its PR badge, so a row off screen reads nothing (no chat history in
// main, no git or gh) until it is scrolled to: every row reading at launch made main's heap reach gigabytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { Thread } from '../src/store/types.ts';
import type { ThreadPullRequest } from '../src/lib/threadPullRequest.ts';

/** The rows the observer watches, and its callback: the test says which row is on screen. */
const observed = new Set<Element>();
let report: (el: Element, on: boolean) => void = () => {};
(globalThis as any).IntersectionObserver = class {
  constructor(callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
    report = (target, isIntersecting) => callback([{ target, isIntersecting }]);
  }
  observe(el: Element) {
    observed.add(el);
  }
  unobserve(el: Element) {
    observed.delete(el);
  }
  disconnect() {}
};

import { sidebarRowKit } from './support/sidebar-row-kit.ts';

const kit = await sidebarRowKit();
const { reads, ThreadRow } = kit;

test('a real row off screen reads its PR only once it is scrolled on screen', async () => {
  kit.result = { url: 'https://github.com/org/repo/pull/42', number: 42, state: 'open' } as ThreadPullRequest;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const thread = (id: string) => ({ id, name: id, cwd: '/repo', updatedAt: 1 }) as Thread;
  try {
    await act(async () =>
      root.render(
        h('div', null, h(ThreadRow, { thread: thread('top'), active: false }), h(ThreadRow, { thread: thread('below'), active: false })),
      ),
    );
    const rows = [...host.querySelectorAll('.thread-row')];
    assert.equal(rows.length, 2);
    assert.deepEqual([...observed], rows, 'each row observes its own element');
    assert.deepEqual(reads, [], 'no row reads before it is known to be on screen');
    await act(async () => {
      report(rows[0], true);
      report(rows[1], false);
    });
    assert.deepEqual(
      reads.map((r) => r[0]),
      ['top'],
    );
    assert.ok(rows[0].querySelector('.thread-pr-badge'));
    assert.equal(rows[1].querySelector('.thread-pr-badge'), null);
    await act(async () => report(rows[1], true));
    assert.deepEqual(
      reads.map((r) => r[0]),
      ['top', 'below'],
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  assert.equal(observed.size, 0);
});
