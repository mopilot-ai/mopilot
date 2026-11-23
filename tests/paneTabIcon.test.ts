// A side pane tab's icon in the title bar: its kind's mark; a browser tab's spinner while its page loads, the agent's
// mark while one drives it, else the globe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { PaneTabIcon } from '../src/components/titleBar/PaneTabIcon.tsx';
import { setPaneLoading, usePaneLoading } from '../src/store/paneLoading.ts';

async function show(tab: any, badge?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(PaneTabIcon, { tab, badge })));
  return { host, close: async () => (await act(async () => root.unmount()), host.remove()) };
}

test("a browser tab's icon spins while its page loads, then shows the agent's mark or the globe again", async () => {
  const v = await show({ id: 'b1', kind: 'browser' }, 'Agent is using this tab');
  try {
    assert.equal(v.host.querySelector('svg.spinner'), null);
    assert.equal(v.host.querySelector('svg')!.getAttribute('aria-label'), 'Agent is using this tab');
    await act(async () => setPaneLoading('b1', true));
    assert.ok(v.host.querySelector('svg.spinner'));
    // a repeated report changes nothing; another tab's load doesn't spin this one
    const state = usePaneLoading.getState();
    setPaneLoading('b1', true);
    assert.equal(usePaneLoading.getState(), state);
    await act(async () => setPaneLoading('b1', false));
    assert.equal(v.host.querySelector('svg.spinner'), null);
    assert.deepEqual(usePaneLoading.getState(), {});
  } finally {
    await v.close();
  }
  const g = await show({ id: 'b2', kind: 'browser' });
  try {
    assert.equal(g.host.querySelector('svg')!.getAttribute('aria-label'), null);
  } finally {
    await g.close();
  }
});

test('every other tab kind shows its own mark, loading or not', async () => {
  for (const kind of ['changes', 'files', 'file', 'skill', 'terminal', 'chat', 'tasks', 'plan']) {
    setPaneLoading('x', true);
    const v = await show({ id: 'x', kind });
    try {
      assert.ok(v.host.querySelector('svg'), kind);
      assert.equal(v.host.querySelector('svg.spinner'), null, kind);
    } finally {
      await v.close();
      setPaneLoading('x', false);
    }
  }
});

test("an artifact tab shows the card's mark: a window for a page, the palette for a Claude Design project", async () => {
  const page = await show({ id: 'a1', kind: 'artifact', artifactKind: 'artifact' });
  const design = await show({ id: 'a2', kind: 'artifact', artifactKind: 'design' });
  try {
    assert.match(String(page.host.querySelector('svg')!.getAttribute('class')), /app-window/);
    assert.match(String(design.host.querySelector('svg')!.getAttribute('class')), /palette/);
  } finally {
    await page.close();
    await design.close();
  }
});
