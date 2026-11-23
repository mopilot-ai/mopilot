// The dev host's stand-in for MoMo's page shell (scripts/mobile-dev-host/scenariosMomoShell.mjs, `momo-shell [on|off]`): the fake Mac's MoMo state says `shell` (and `shellTasks` with the panel) only while it is on, the scenario flips it and tells the phones MoMo's settings changed, and the host adds it to the scenarios createScenarios makes without that list being edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeMomo } from '../scripts/mobile-dev-host/fakeMomo.mjs';
import { momoShellScenario, withMomoShell } from '../scripts/mobile-dev-host/scenariosMomoShell.mjs';

const NOW = new Date(2026, 10, 15, 12, 0).getTime();

function momoWith(o: { shell?: boolean; panel?: boolean } = {}) {
  const app = createFakeApp({ repo: '/repo', now: () => NOW, sleep: async () => undefined, status: async () => ' M a\n' });
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const bench = { shell: o.shell ?? false };
  const momo = createFakeMomo({
    app,
    brainChangeAllowed: () => true,
    changed: () => undefined,
    now: () => NOW,
    tasksPanel: () => o.panel ?? true,
    shell: () => bench.shell,
  });
  return { momo, bench };
}

test('the fake Mac says nothing of the shell until it is on, then says it and whether the Tasks panel is too', async () => {
  const { momo, bench } = momoWith();
  assert.equal('shell' in (await momo.state()), false);
  bench.shell = true;
  assert.deepEqual([(await momo.state()).shell, (await momo.state()).shellTasks], [true, true]);
  const noPanel = momoWith({ shell: true, panel: false });
  assert.equal((await noPanel.momo.state()).shellTasks, false);
  const none = createFakeMomo({
    app: createFakeApp({ repo: '/repo', now: () => NOW, sleep: async () => undefined, status: async () => '' }),
    brainChangeAllowed: () => true,
    changed: () => undefined,
  });
  assert.equal('shell' in (await none.state()), false, 'a fake made without the option is an older Mac');
  assert.equal('v' in ((await none.tasks.list()) as object), false, 'and lists the classic tasks, not the four tabs');
  // and one made with the panel and no failing switch reads its tasks as it always did
  const panelOnly = createFakeMomo({
    app: createFakeApp({ repo: '/repo', now: () => NOW, sleep: async () => undefined, status: async () => '' }),
    brainChangeAllowed: () => true,
    changed: () => undefined,
    now: () => NOW,
    tasksPanel: () => true,
  });
  assert.equal(((await panelOnly.tasks.list()) as { v: number }).v, 2);
});

test('momo-shell on and off flip the bench, tell the phones MoMo’s settings changed, and refuse any other word', () => {
  const bench: { shell?: boolean } = {};
  const told: string[] = [];
  const s = momoShellScenario(bench, (area) => void told.push(area));
  assert.equal(s.usage, 'momo-shell [on|off]');
  assert.match(s.run([]), /shell is on.*Tasks needs momo-tasks on/);
  assert.equal(bench.shell, true);
  assert.match(s.run(['OFF']), /shell is off: the open MoMo page reads it at once$/);
  assert.equal(bench.shell, false);
  assert.deepEqual(told, ['prefs', 'prefs']);
  assert.throws(() => s.run(['maybe']), /Usage: momo-shell \[on\|off\]/);
  assert.deepEqual(told, ['prefs', 'prefs'], 'a refused word changes nothing');
});

test('the host adds the scenario to the others: listed, run by name, and every other name still goes to the others', () => {
  const ran: string[][] = [];
  const base = {
    list: () => [{ usage: 'momo', about: 'MoMo allowed or not' }],
    run: (name: string, args: string[] = []) => (ran.push([name, ...args]), `ran ${name}`),
  };
  const bench: { shell?: boolean } = {};
  const all = withMomoShell(base, bench, () => undefined);
  assert.deepEqual(
    all.list().map((s) => s.usage),
    ['momo', 'momo-shell [on|off]'],
  );
  assert.match(all.list()[1].about, /Chat · Tasks · Files/);
  assert.equal(all.run('momo', ['on']), 'ran momo');
  assert.deepEqual(ran, [['momo', 'on']]);
  assert.match(String(all.run('momo-shell')), /shell is on/);
  assert.equal(bench.shell, true);
  assert.equal(all.run('momo'), 'ran momo', 'no args: the default list');
});
