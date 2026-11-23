// src/components/harness/UpdateProgress.tsx and its use in HarnessUpdate.tsx: an update shows how long it has run and,
// under its terminal, that a long silent download is still going or that a second download runs (#3518).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
let version: any = null;
installNativeStub({ harnessUpdates: {}, harnessRuns: { stop: async () => true } });
stubStore({ toast: () => undefined });
mock.module('../src/harness/harnessUpdates.ts', { namedExports: { useVersionOf: () => version } });
mock.module('../src/components/panels/TerminalPanel.tsx', { namedExports: { TermView: () => h('pre', { 'data-term': true }) } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: () => undefined } });
const { progressNote, elapsedText, SLOW_MS } = await import('../src/components/harness/UpdateProgress.tsx');
const { useHarnessRuns } = await import('../src/session/harness/harnessRuns.ts');
const { useHarnessUpdate, UpdatePill, UpdateFlow } = await import('../src/components/harness/HarnessUpdate.tsx');

test('the note: a second download says so; a run past the slow mark is still downloading; else none', () => {
  assert.equal(progressNote(true, 1000), "The first download didn't finish. Downloading again.");
  assert.equal(progressNote(false, SLOW_MS), 'Still downloading. This can take a few minutes on a slow connection.');
  assert.equal(progressNote(false, SLOW_MS - 1), null);
  assert.equal(progressNote(false, null), null);
  assert.equal(elapsedText(null), '');
  assert.equal(elapsedText(65_000), '1m 5s');
});

function Both({ kind }: { kind: string }) {
  const u = useHarnessUpdate(kind, 'Codex');
  return u ? h('div', null, h(UpdatePill, { u }), h(UpdateFlow, { u })) : null;
}

const info = (patch: any) => ({
  harness: 'codex',
  installed: '0.147.0',
  latest: '0.166.0',
  updatable: true,
  command: 'npm install -g @openai/codex@latest',
  state: 'idle',
  waitingFor: 0,
  runId: null,
  outcome: null,
  ...patch,
});
const run = (patch: any) => ({
  id: 'r1',
  kind: 'codex',
  command: 'npm …',
  quiet: false,
  state: 'running',
  startedAt: Date.now(),
  ...patch,
});

test('while updating, the pill shows the time it has run and the terminal says it is still downloading', async () => {
  version = info({ state: 'updating', runId: 'r1' });
  await act(async () => useHarnessRuns.setState({ runs: [run({ startedAt: Date.now() - 65_000 })] as any }));
  const v = await render(h(Both, { kind: 'codex' }));
  assert.match(v.host.querySelector('.hver-pill')!.textContent!, /Updating… 1m 5s/);
  assert.equal(v.host.querySelector('.install-note')!.textContent, 'Still downloading. This can take a few minutes on a slow connection.');
  assert.ok(v.host.querySelector('[data-term]'));
  await act(async () => useHarnessRuns.setState({ runs: [run({ stopped: true })] as any }));
  assert.match(v.host.querySelector('.hver-pill')!.textContent!, /Stopping…/);
  assert.equal(v.host.querySelector('.install-note'), null, 'a stopped request is not still downloading');
  assert.match(v.host.querySelector('.install-foot [role=status]')!.textContent!, /Stopping…/);
  assert.ok(v.host.querySelector('[data-term]'), 'cleanup keeps its terminal attached');
  await v.unmount();
});

test('a second download says so from its first second; an update not yet started shows no time', async () => {
  version = info({ state: 'updating', runId: 'r2', retrying: true });
  await act(async () => useHarnessRuns.setState({ runs: [run({ id: 'r2', startedAt: Date.now() })] as any }));
  const v = await render(h(Both, { kind: 'codex' }));
  assert.equal(v.host.querySelector('.install-note')!.textContent, "The first download didn't finish. Downloading again.");
  await v.unmount();
  // updating, but its run isn't in this window yet: no time, no note
  version = info({ state: 'updating', runId: 'gone' });
  const w = await render(h(Both, { kind: 'codex' }));
  assert.equal(w.host.querySelector('.hver-pill')!.textContent!.trim(), 'Updating…');
  assert.equal(w.host.querySelector('.install-note'), null);
  await w.unmount();
});
