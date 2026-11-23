// src/components/harness/HarnessUpdatesBar.tsx: "N harnesses have updates · Update all" (two or more), Update all's
// progress, Cancel and summary, and "Last checked … · Check for updates", read again when the page opens.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, byText, maybeText } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const { create } = await import('zustand');
const calls: any[] = [];
const state = create<any>(() => ({ harnesses: [], all: null, checkedAt: null, checking: false }));
let fail: unknown = null;
const act$ =
  (name: string) =>
  async (...a: any[]) => {
    calls.push([name, ...a]);
    if (fail) throw fail;
    return true;
  };
installNativeStub({ harnessUpdates: { updateAll: act$('updateAll'), cancelAll: act$('cancelAll') } });
stubStore({ toast: (...a: any[]) => calls.push(['toast', ...a]) });
mock.module('../src/harness/harnessUpdates.ts', {
  namedExports: {
    useHarnessUpdates: state,
    checkHarnessUpdates: async (force?: boolean) => calls.push(['check', force]),
    updatableCount: (s: any) => s.harnesses.filter((x: any) => x.updatable).length,
  },
});
const { HarnessUpdatesBanner, HarnessUpdatesFoot, ago } = await import('../src/components/harness/HarnessUpdatesBar.tsx');

const set = (patch: any) => act(async () => state.setState(patch));
const row = (harness: string, updatable = true) => ({ harness, updatable });

test('"12 min ago": just now, minutes, hours, days', () => {
  const now = 10 * 86_400_000;
  assert.equal(ago(now - 30_000, now), 'just now');
  assert.equal(ago(now - 12 * 60_000, now), '12 min ago');
  assert.equal(ago(now - 3 * 3600_000, now), '3 h ago');
  assert.equal(ago(now - 2 * 86_400_000, now), '2 d ago');
  assert.equal(typeof ago(Date.now()), 'string');
});

test('the banner shows for two updates or more, names them, and Update all starts them; the page reads versions on open', async () => {
  calls.length = 0;
  await set({ harnesses: [row('claude'), row('codex', false)], all: null });
  const v = await render(h(HarnessUpdatesBanner));
  assert.deepEqual(calls, [['check', undefined]]);
  assert.equal(v.host.innerHTML, '', 'one is enough with its own pill');
  await set({ harnesses: [row('claude'), row('acp:opencode'), row('acp:unknown')] });
  assert.equal(v.host.querySelector('.hupd-banner span')!.textContent, '3 harnesses have updates: Claude Code, opencode, acp:unknown');
  await click(byText(v.host, 'Update all'));
  fail = new Error('IPC down');
  await click(byText(v.host, 'Update all'));
  fail = null;
  await act(async () => undefined);
  assert.deepEqual(calls.slice(1), [['updateAll'], ['updateAll'], ['toast', "Couldn't update the harnesses: IPC down", 'error']]);
  await v.unmount();
});

test('while Update all runs: which one, how far, and Cancel; once cancelled it says it stops after the current one', async () => {
  calls.length = 0;
  await set({
    harnesses: [row('claude'), row('codex')],
    all: { running: true, total: 2, index: 1, current: 'claude', results: [], cancelled: false },
  });
  const v = await render(h(HarnessUpdatesBanner));
  assert.equal(v.host.querySelector('.hupd-banner')!.getAttribute('role'), 'status');
  assert.equal(v.host.querySelector('.hupd-banner span')!.textContent, 'Updating Claude Code… (1 of 2)');
  await click(byText(v.host, 'Cancel'));
  assert.deepEqual(calls.at(-1), ['cancelAll']);
  await set({ all: { running: true, total: 2, index: 1, current: null, results: [], cancelled: true } });
  assert.equal(v.host.querySelector('.hupd-banner span')!.textContent, 'Stopping after …… (1 of 2)');
  assert.equal(maybeText(v.host, 'Cancel'), null);
  await v.unmount();
});

test("after Update all: who updated from what to what, who didn't with why on hover; the button stays only if two still have updates", async () => {
  const results = [
    { harness: 'claude', outcome: { result: 'updated', from: '2.1.296', to: '2.1.302', message: 'Updated' } },
    { harness: 'acp:opencode', outcome: { result: 'failed', from: null, to: null, message: "Didn't update: EACCES" } },
    { harness: 'codex', outcome: null },
    { harness: 'acp:kimi', outcome: { result: 'updated', from: null, to: null, message: 'Updated' } },
  ];
  await set({ harnesses: [row('claude', false)], all: { running: false, total: 4, index: 4, current: null, results, cancelled: false } });
  const v = await render(h(HarnessUpdatesBanner));
  const span = v.host.querySelector('.hupd-banner span')!;
  assert.equal(span.textContent, "2 of 4 harnesses updated: Claude Code 2.1.296 → 2.1.302 · Kimi Code · opencode, Codex didn't");
  assert.equal(span.getAttribute('title'), "opencode: Didn't update: EACCES\nCodex: cancelled");
  assert.equal(maybeText(v.host, 'Update all'), null);
  await set({ all: { running: false, total: 1, index: 1, current: null, results: [results[0]], cancelled: false } });
  assert.equal(v.host.querySelector('.hupd-banner span')!.textContent, '1 of 1 harness updated: Claude Code 2.1.296 → 2.1.302');
  assert.equal(v.host.querySelector('.hupd-banner span')!.getAttribute('title'), null);
  // two have updates again: the count and the button, not the old summary
  await set({ harnesses: [row('claude'), row('codex')] });
  assert.match(v.host.querySelector('.hupd-banner span')!.textContent!, /^2 harnesses have updates/);
  // an Update all that ended with nothing run says nothing
  await set({ harnesses: [], all: { running: false, total: 0, index: 0, current: null, results: [], cancelled: true } });
  assert.equal(v.host.innerHTML, '');
  await v.unmount();
});

test('the foot: when it last checked, and Check for updates (spinning, and off, while it checks)', async () => {
  calls.length = 0;
  await set({ checkedAt: null, checking: false });
  const v = await render(h(HarnessUpdatesFoot));
  assert.equal(v.host.querySelector('.hupd-foot > span'), null);
  await click(byText(v.host, 'Check for updates'));
  assert.deepEqual(calls, [['check', true]]);
  await set({ checkedAt: Date.now(), checking: true });
  assert.equal(v.host.querySelector('.hupd-foot > span')!.textContent, 'Last checked just now');
  assert.ok((byText(v.host, 'Check for updates') as HTMLButtonElement).disabled);
  await v.unmount();
});
