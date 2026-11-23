// e2e-runner: bench
// MM3 stage 1, the journey of the Remote Run acceptance matrix (design/remote-run/plan.md "The journey each cell passes") for the Mac app against two backends, the same fake ACP agent behind each, and the timings the owner's "smooth" is judged by: a chat on **This Mac** (the app runs the agent) and on **This Mac · keeps running** (the launch agent the app installs, with the agent defined for that Host). Each: start and stream a reply, a tool call, an approval answered, Stop, quit and reopen with the history there and the chat usable, a second chat and switching between them.
// Timings (start (the picks and the send) to first token, chat open, chat switch, approval round trip) print as `MM3-TIMING {json}` lines, which the run's report carries. It installs a per-user launch agent for the second backend, so it runs only on a CI runner or in an isolated VM (MOPILOT_ACCEPT_VM=1). Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/mm3-journey.spec.ts`.
import { test } from './fixtures/app';
import { type Backend, runJourney, send } from './fixtures/mm3Journey';
import { openHarnessList } from './fixtures/harnessPicker';
import { HOME, installThisMac, removeHostFiles, startChatOnThisMac } from './fixtures/hostLocal';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS && !process.env.MOPILOT_ACCEPT_VM, 'a runner or an isolated VM only: it installs a launch agent');

const BACKENDS: Backend[] = [
  {
    name: 'This Mac',
    setup: async () => undefined,
    async start(h, message, another) {
      if (another) await h.page.getByRole('button', { name: 'New chat' }).first().click();
      await openHarnessList(h.page);
      await h.page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
      await send(h.page, message);
    },
  },
  {
    name: 'This Mac · keeps running',
    setup: (h) => installThisMac(h),
    start: (h, message, another) => startChatOnThisMac(h, message, { another }),
    cleanup: async (h) => void (await h.page.evaluate(() => window.native.host.removeLocal())),
  },
];

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);
test.afterEach(removeHostFiles);
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.local=1', HOME },
});

for (const backend of BACKENDS) {
  test(`${backend.name}: start, stream, a tool, an approval, Stop, quit and reopen, a second chat`, ({ harness }) =>
    runJourney(harness, backend));
}
