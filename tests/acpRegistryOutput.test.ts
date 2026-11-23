// Registry installation output follows the main-owned run, preserves finished logs and exposes Stop after Settings reopens.
import './support/dom.ts';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import { render, click, byText } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
const stops: string[] = [];
installNativeStub({
  harnessRuns: {
    stop: async (id: string) => {
      stops.push(id);
    },
  },
});
mock.module('../src/components/panels/TerminalPanel.tsx', {
  exports: {
    TermView: ({ tab, transport, onExit, readOnly }: any) =>
      h(
        'button',
        { 'data-term': tab.id, 'data-transport': typeof transport, 'data-read-only': String(readOnly), onClick: onExit },
        tab.title,
      ),
  },
});
const { RegistryInstallOutput } = await import('../src/components/harness/RegistryInstallOutput.tsx');
const { useHarnessRuns } = await import('../src/session/harness/harnessRuns.ts');

test('running, finished, hidden, replaced and missing installation logs keep their own run identity', async () => {
  await act(async () => useHarnessRuns.setState({ runs: [] }));
  const view = await render(h(RegistryInstallOutput, { id: 'example' }));
  assert.equal(view.host.textContent, '');
  const run: any = { id: 'run-1', kind: 'acp:registry-example', state: 'running', command: 'npm exec example' };
  await act(async () => useHarnessRuns.setState({ runs: [run] }));
  assert.equal(view.host.querySelector('[data-term]')?.getAttribute('data-term'), 'run-1');
  assert.equal(view.host.querySelector('[data-term]')?.getAttribute('data-transport'), 'function');
  assert.equal(view.host.querySelector('[data-term]')?.getAttribute('data-read-only'), 'true');
  await click(byText(view.host, run.command));
  await click(byText(view.host, 'Stop'));
  assert.deepEqual(stops, ['run-1']);
  await act(async () => useHarnessRuns.setState({ runs: [{ ...run, stopped: true }] }));
  assert.match(view.host.querySelector('[role=status]')!.textContent!, /Stopping…/);
  assert.ok(view.host.querySelector('[data-term]'), 'cleanup keeps the attached log visible');
  await click(byText(view.host, 'Stop'));
  assert.deepEqual(stops, ['run-1', 'run-1'], 'Stop remains available for a failed cleanup retry');
  await act(async () => useHarnessRuns.setState({ runs: [{ ...run, state: 'exited' }] }));
  assert.equal(view.host.querySelector('[data-term]'), null);
  await click(byText(view.host, 'Show installation output'));
  assert.ok(view.host.querySelector('[data-term]'));
  await click(byText(view.host, 'Hide installation output'));
  assert.equal(view.host.querySelector('[data-term]'), null);
  await click(byText(view.host, 'Show installation output'));
  await act(async () => useHarnessRuns.setState({ runs: [{ ...run, id: 'run-2', state: 'exited' }] }));
  assert.equal(view.host.querySelector('[data-term]'), null);
  await view.unmount();
});
