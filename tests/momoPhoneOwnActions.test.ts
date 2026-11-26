// The phone's own home offers no action that only the Mac can run, on any surface: the banner, the machine rows, the task failures, with or without a fix of the home's own. The Mac's home offers every one of them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const vmPath = '../mobile/src/momoPhone/workModels';
const vmHomePath = '../mobile/src/momoPhone/viewModels';
const fxPath = '../mobile/src/momoPhone/fixtures';
const vm = { ...(await import(vmHomePath)), ...(await import(vmPath)) };
const { fixtureView, fixtureShared } = await import(fxPath);

const MACHINE = /^(wake|update-machine|set-up-machine|install-agent|sign-in-agent)$/;
const MACHINE_FIX = /^(wake|update-machine|set-up-machine|install-agent|sign-in-agent)(:|$)/;
const isMachine = (a: { intent: { kind: string; id?: string } }) =>
  MACHINE.test(a.intent.kind) || (a.intent.kind === 'fix' && MACHINE_FIX.test(a.intent.id ?? ''));

const mini = { machineId: 'mini', name: 'Mac mini' };
const machines = ['needs-update', 'not-set-up', 'online', 'offline'].map((status, i) => ({
  machineId: `m${i}`,
  name: `Machine ${i}`,
  isThisDevice: false,
  isHome: false,
  status,
  note: null,
  recommended: false,
  agentsSignedIn: [],
}));
const failure = (code: string, fix: { id: string; label: string } | null) => ({
  code,
  message: 'it failed',
  machine: mini,
  agent: 'Codex',
  fix,
});

/** Every action a view can offer on every surface that builds machine actions. */
function everyAction(own: boolean) {
  const found: { surface: string; action: any }[] = [];
  const view = (edit: (v: any) => void) => {
    const shared = fixtureShared();
    shared.home.machines = machines;
    edit(shared);
    return fixtureView({ view: shared, ...(own ? { own: true } : {}) });
  };
  for (const state of ['asleep', 'needs-update', 'needs-sign-in', 'running', 'moving']) {
    for (const agentProblem of [
      null,
      { kind: 'signed-out', agent: 'Claude Code', fix: { id: 'sign-in-agent:m:claude', label: 'Sign in on Mac mini' } },
      { kind: 'not-installed', agent: 'Codex', fix: null },
    ]) {
      const v = view((s) => Object.assign(s.home, { state, stateSince: 1, agentProblem }));
      for (const a of vm.homeBanner(v)?.actions ?? []) found.push({ surface: `banner ${state}`, action: a });
      for (const r of [...vm.whereRows(v).others, vm.whereRows(v).here])
        if (r?.action) found.push({ surface: `row ${r.name}`, action: r.action });
    }
  }
  for (const code of ['agent-missing', 'agent-signed-out', 'restarted', 'other']) {
    for (const fix of [
      null,
      { id: 'install-agent:mini:codex', label: 'Install Codex' },
      { id: 'sign-in-agent:mini:codex', label: 'Sign in' },
      { id: 'unrelated', label: 'Do it' },
    ]) {
      const v = view(() => undefined);
      const task = { ...fixtureShared().tasks[0], state: 'failed', failure: failure(code, fix) };
      for (const a of vm.taskDetail(v, task).problem?.actions ?? []) found.push({ surface: `task ${code}`, action: a });
    }
  }
  return found;
}

test('on the phone’s own home no surface offers an action only the Mac can run, and what is not the Mac’s stays', () => {
  const own = everyAction(true);
  assert.ok(own.length > 10, 'the walk saw the surfaces');
  assert.deepEqual(
    own.filter((x) => isMachine(x.action)).map((x) => `${x.surface}: ${x.action.label}`),
    [],
  );
  // a way on that is not the Mac's is still there: moving, running a task elsewhere, trying again
  assert.ok(own.some((x) => x.action.intent.kind === 'task-retry' || x.action.intent.kind === 'open-where'));
});

test('on the Mac’s home every one of them is offered', () => {
  const mac = everyAction(false);
  for (const kind of ['wake', 'update-machine', 'install-agent', 'sign-in-agent'])
    assert.ok(
      mac.some((x) => x.action.intent.kind === kind),
      kind,
    );
  assert.ok(mac.some((x) => x.action.intent.kind === 'fix' && MACHINE_FIX.test(x.action.intent.id)));
});
