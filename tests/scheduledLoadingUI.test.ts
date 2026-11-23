// The Scheduled page's navigation (src/components/pages/Scheduled.tsx) reports a task list that failed to load,
// and malformed tasks one by one, while keeping the valid ones. Page state and navigation run for real.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { importsToStub } from './support/source-modules.ts';
import { installNativeStub } from './support/ports/native.ts';

const fixture: any = { toasts: [], list: async () => [] };
const page = new URL('../src/components/pages/Scheduled.tsx', import.meta.url);
const at = (rel: string) => new URL(rel, page).href;
const inert = () => null;
/** The exports these cases drive; every other imported name is inert. */
const overrides: Record<string, Record<string, unknown>> = {
  // the scheduled components import toast from the slice that owns it
  [at('../../store/core.ts')]: { toast: (...args: unknown[]) => fixture.toasts.push(args) },
  [at('../../lib/automations.ts')]: {
    listAutomations: (onError: unknown) => fixture.list(onError),
    PRESETS: [{}, {}],
    taskState: () => ({ kind: 'unscheduled' }),
    TASK_STATE_LABEL: { unscheduled: 'No next run' },
  },
  [at('../../harness/copy.ts')]: { COPY: { scheduled: { subtitle: 'Tasks' } } },
  [at('../ui/Popover.tsx')]: { useAnchor: () => ({}), Tooltip: ({ children }: { children: unknown }) => children },
  [at('../../lib/ignored.ts')]: { errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)) },
  // each row names its harness
  [at('../../lib/scheduleTask.ts')]: { runWithOf: () => 'codex', runWithLabel: () => 'Codex' },
};
const navigation = new URL('./scheduled/ScheduledNav.tsx', page);
const state = new URL('./scheduled/state.ts', page);
// the bridge, installed in the port the modules read (src/lib/native.ts, real here)
installNativeStub({ automation: { onChanged: () => () => {} } });
for (const [file, names] of importsToStub(
  [page, navigation, state],
  (module) =>
    module.href === at('../../lib/native.ts') ||
    module.href === at('../../lib/latestLoader.ts') ||
    module.href === at('../../../shared/scheduleTask.mjs'),
))
  mock.module(file, {
    namedExports: Object.fromEntries([...names].map((n) => [n, overrides[file]?.[n] ?? inert])),
  });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ScheduledNav } = await import(page.href);
const { reload, useSched } = await import(state.href);

for (const outcome of ['success', 'failure', 'partial-error'] as const) {
  test(`scheduled list ignores obsolete ${outcome} after a newer reload`, async () => {
    fixture.toasts = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fixture.list = async (onError: (message: string) => void) => {
      await gate;
      if (outcome === 'failure') throw new Error('obsolete failure');
      if (outcome === 'partial-error') onError('obsolete partial error');
      return [{ id: 'old', name: 'Obsolete task' }];
    };
    const older = reload();
    const current = [{ id: 'new', name: 'Current task' }];
    fixture.list = async () => current;
    await reload();
    finish();
    await older;
    assert.deepEqual(useSched.getState().list, current);
    assert.deepEqual(fixture.toasts, []);
  });
}

for (const failure of [null, new Error('directory unavailable'), 'offline']) {
  test(`scheduled navigation reports ${failure ?? 'individual malformed tasks'} and retains valid tasks`, async () => {
    fixture.toasts = [];
    fixture.list = async (onError: any) => {
      if (failure) throw failure;
      onError('Could not read broken/automation.toml');
      return [{ id: 'valid', name: 'Valid task', rrule: '', status: 'PAUSED' }];
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host as any);
    try {
      await act(async () => root.render(createElement(ScheduledNav)));
      assert.deepEqual(fixture.toasts, [
        [
          failure
            ? `Couldn't load scheduled tasks: ${failure instanceof Error ? failure.message : failure}`
            : 'Could not read broken/automation.toml',
          'error',
        ],
      ]);
      if (!failure) assert.match(host.textContent!, /Valid task/);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
}
