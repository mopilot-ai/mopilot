// The cells of the cloud acceptance run (S9, plan.md): the machine is made, the Host installed on it with the app's own installer, a turn run, the machine stopped and woken, a limit held. Each step is the Host acceptance run's own step where one exists (A2, A3, A5, A6, S10) and runs on the machine over SSH.
import { HOST_NODE } from '../../../electron/host/installRuntime.cjs';
import { STEPS, ask, chat, expect, replyOf } from '../steps.mjs';
import { M4_STEPS } from '../milestones/m4.mjs';
import { idleStopWired } from './dry.mjs';
import { launchMachine, stopMachine, wakeMachine } from './machine.mjs';

const byId = Object.fromEntries(STEPS.map((s) => [s.id, s]));
/** Seconds with one decimal. @param {number} ms */
const s = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * The cloud cells in order. @param {(id: string) => any} [pick] a step to use in place of the Host acceptance run's own (a test's)
 */
export function cloudSteps(pick = () => undefined) {
  /** @param {string} id @param {any} own */
  const host = (id, own) => pick(id) ?? own;
  const installer = host('A3', byId.A3);
  /** The installer step, with the moment the Host answered kept for the timings. */
  const install = {
    ...installer,
    fatal: true,
    async run(/** @type {any} */ ctx) {
      const detail = await installer.run(ctx);
      ctx.cloud.t.hostAnswered = ctx.cloud.deps.now();
      return detail;
    },
  };
  return [
    {
      id: 'C1',
      title: 'M4/S9 Create a machine with the app’s cloud launcher: it runs and answers SSH',
      fatal: true,
      async run(/** @type {any} */ ctx) {
        const { cloud } = ctx;
        const made = await launchMachine(cloud);
        ctx.target = `ubuntu@${cloud.addr.ip}`;
        const { t } = cloud;
        return `${made.providerId.slice(-8)} in ${cloud.made.ad.split(':').pop()}; create→running ${s(t.running - t.create)}, running→SSH ${s(t.ssh - t.running)}`;
      },
    },
    {
      id: 'C2',
      title: 'The machine can run the Host (Linux, nc, a systemd user manager)',
      fatal: true,
      async run(/** @type {any} */ ctx) {
        const r = await ctx.m.run('uname -sm; for c in nc loginctl; do command -v $c >/dev/null && echo "have $c"; done');
        expect(r.code === 0, `The machine could not be asked: ${r.stderr.trim() || r.stdout.trim()}`);
        const [uname, ...lines] = r.stdout.trim().split('\n');
        const missing = ['nc', 'loginctl'].filter((c) => !lines.includes(`have ${c}`));
        expect(missing.length === 0, `The machine lacks ${missing.join(' and ')}.`);
        expect(uname.startsWith('Linux'), `Expected Linux, got ${uname}.`);
        ctx.state.os = uname.split(' ')[0];
        ctx.state.platform = uname;
        return `${uname}; nc and loginctl present; no system Node needed (the installer brings the Host's own)`;
      },
    },
    { ...host('A2', byId.A2), fatal: true },
    install,
    {
      id: 'C2n',
      title: 'The Host’s own Node is where the installer put it',
      fatal: true,
      async run(/** @type {any} */ ctx) {
        const r = await ctx.m.run(`p="${HOST_NODE}"; [ -x "$p" ] && echo "$p"`);
        expect(r.code === 0 && r.stdout.trim(), 'The installer left no Node for the Host.');
        ctx.state.nodePath = r.stdout.trim();
        return ctx.state.nodePath;
      },
    },
    { ...host('A5', byId.A5), fatal: true },
    { ...host('A6', byId.A6), fatal: true, title: 'M4/S9 A chat on the fake ACP agent runs a turn on the machine' },
    {
      id: 'C3',
      title: 'M4/S9 Idle stop: the machine stops itself after the idle time',
      async run(/** @type {any} */ ctx) {
        return {
          skip: idleStopWired(ctx.root)
            ? 'The Host builds createIdleStop now, but this run does not wait out the idle time yet.'
            : 'NOT WIRED: nothing under host/ calls createIdleStop, so a machine never stops itself. The provider path of a stop is checked next (C3b).',
        };
      },
    },
    {
      id: 'C3b',
      title: 'M4/S9 Stop now: the adapter stops the machine and the provider shows STOPPED',
      async run(/** @type {any} */ ctx) {
        ctx.cloud.t.stop = await stopMachine(ctx.cloud);
        return `stop→STOPPED ${s(ctx.cloud.t.stop)}, read from the adapter and from the provider's own list`;
      },
    },
    {
      id: 'C4',
      title: 'M4/S9 A message wakes the machine (the app’s wake) and the turn runs',
      async run(/** @type {any} */ ctx) {
        const { cloud } = ctx;
        const wake = await wakeMachine(cloud, ctx);
        expect(
          wake.state === 'online',
          `The wake ended ${wake.state}${/** @type {any} */ (wake).reason ? `: ${/** @type {any} */ (wake).reason}` : ''} (${wake.states.join(' → ')})${wake.lastLook ? `; the last look: ${wake.lastLook}` : ''}.`,
        );
        cloud.t.wakeHost = wake.ms;
        const id = chat(ctx, 3);
        const c = await ask(ctx, id, 'hello after wake');
        try {
          const reply = (await c.waitFor(replyOf(id), 30_000)).frame.item;
          cloud.t.wakeFrame = cloud.deps.now() - wake.started;
          expect(reply.text === 'fake-acp: hello after wake', `The reply was "${reply.text}".`);
        } finally {
          c.close();
        }
        return `wake→Host answering ${s(cloud.t.wakeHost)}, wake→reply ${s(cloud.t.wakeFrame)} (${wake.states.join(' → ')})`;
      },
    },
    {
      ...host('S10', M4_STEPS[0]),
      title: 'M4/S10 A day spend limit on the machine holds the next send with spend_limit, and raising it lets it go',
    },
  ];
}
