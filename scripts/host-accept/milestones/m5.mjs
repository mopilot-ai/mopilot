// Milestone M5 (quit the app): S11, a turn that is running on the local Host when the app is killed with SIGKILL runs on and is never reported as interrupted. The Host is the one the run installed with the app's own installer, the install path `host.local` uses for This Mac. S11b runs it with a real app process: the fake-E2E spec tests/e2e/host-local-quit.spec.ts starts a dev build on the machine, quits it and kills it mid-turn.
import { HOST_CLI } from '../../../electron/host/install.cjs';
import { ask, chat, expect, hostUp, session } from '../steps.mjs';
import { answerCard, eventOf, framesOf, killApp, later as fromNow, optionOf, pending, waitCard } from './common.mjs';

/** What would read as an interrupted turn in the chat's record. */
const INTERRUPTED = /interrupt|"stopReason":"cancelled"|host_restarted/i;

export const M5_STEPS = [
  {
    id: 'S11',
    title: 'M5/S11 kill -9 on the app mid-turn: the turn finishes and nothing reports it as interrupted',
    async run(ctx) {
      const id = chat(ctx, 13);
      // a turn that waits for an answer is running when the app goes; the answer comes from a client that connects afterwards
      const c = await ask(ctx, id, 'PERMIT outlive the app');
      const card = await waitCard(c, id);
      c.close();
      const app = await killApp(ctx);
      const up = await hostUp(ctx);
      expect(up.pid === ctx.state.pid, `The Host was replaced (${ctx.state.pid} to ${up.pid}) when the app was killed.`);
      const later = await session(ctx);
      try {
        await later.request('chat.subscribe', { chatId: id, epoch: 1, fromRev: 0 });
        const waiting = await waitCard(later, id);
        expect(waiting.requestId === card.requestId, 'The card the new client sees is not the one the killed app left.');
        const ended = fromNow(later, eventOf(id, 'turnEnd'));
        await answerCard(later, waiting, optionOf(waiting, 'allow').optionId, 's11');
        const end = await later.waitFor(ended, 30_000);
        expect(end.frame.item.event.stopReason === 'end_turn', `The turn ended with ${end.frame.item.event.stopReason}.`);
        const seen = JSON.stringify(framesOf(later, id));
        expect(!INTERRUPTED.test(seen), 'The chat’s record reports the turn as interrupted.');
        expect(
          (await pending(later)).attention.every((a) => a.chatId !== id),
          'The chat is marked as needing attention after the turn finished.',
        );
        return `${app}; Host ${up.pid} stayed up; the card was still there, Allow let the turn end as end_turn; no interrupted marker in ${framesOf(later, id).length} frames`;
      } finally {
        later.close();
      }
    },
  },
  {
    id: 'S11b',
    title:
      'M5/S11 with a real app: quit and kill -9 mid-turn on This Mac · keeps running; the turn runs on, the exit sheet says so, nothing is interrupted',
    async run(ctx) {
      const repo = ctx.opts.appRepo;
      if (!repo)
        return {
          skip: 'No --app-repo: S11 above dropped only a client; pass a checkout of this branch on the machine to run it with a real app.',
        };
      // the spec installs the app's own Host for this user under the label this run's Host holds: this run's goes first (cleanup removes the rest)
      await ctx.m.run(`${HOST_CLI} uninstall`);
      const away = ctx.opts.awayMin ? ` S11_AWAY_MS=${Math.round(ctx.opts.awayMin * 60_000)}` : '';
      const out = await ctx.m.run(
        `cd ${repo} && MOPILOT_ACCEPT_VM=1${away} npx playwright test -c tests/e2e tests/e2e/host-local-quit.spec.ts --reporter=line 2>&1 | tail -n 40`,
        undefined,
        { timeoutMs: 30 * 60_000 },
      );
      const summary = out.stdout.trim().split('\n').slice(-12).join('\n');
      const passed = /\b(\d+) passed\b/.exec(out.stdout)?.[1];
      expect(
        out.code === 0 && passed === '2' && !/\b(failed|skipped|did not run)\b/.test(out.stdout),
        `The app spec did not pass both tests:\n${summary}`,
      );
      return `quit and SIGKILL with a real app: 2 passed${ctx.opts.awayMin ? ` (${ctx.opts.awayMin} min away)` : ''}`;
    },
  },
];
