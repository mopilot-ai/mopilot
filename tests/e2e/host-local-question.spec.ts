// e2e-runner: bench
// J4 on This Mac · keeps running: the Host the app installs as a launch agent, with the repo's fake Claude CLI and fake Codex app-server found on the PATH the app installed it with. The agent asks a question (Claude Code's AskUserQuestion, Codex's requestUserInput), the card shows in the chat, the answer reaches the agent (its log), the card settles to "Answered.", and the chat's picker offers only its own agent.
// It installs a per-user launch agent, so it runs only on a CI runner or in an isolated VM (MOPILOT_ACCEPT_VM=1). Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-local-question.spec.ts`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';
import { HOME, installThisMac, removeHostFiles, startChatOnThisMac, thisMacRow } from './fixtures/hostLocal';
import { send } from './fixtures/mm3Journey';
import { answerTheQuestion, fakeAgentBins, logged, pickerOffersOnly } from './fixtures/hostQuestion';

test.skip(process.platform !== 'darwin', 'the Host runs as a launchd agent on macOS');
test.skip(!process.env.GITHUB_ACTIONS && !process.env.MOPILOT_ACCEPT_VM, 'a runner or an isolated VM only: it installs a launch agent');

const DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-local-agents-')));
const agents = fakeAgentBins(DIR);
const hostLog = path.join(HOME, 'Library', 'Application Support', 'mopilot-host', 'host.log');

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);
test.afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));
test.afterEach(removeHostFiles);
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  // the Host installed from this app takes the app's PATH into its plist: the fakes are on it
  shellPath: [agents.bin],
  env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.local=1', HOME },
});

/** The Host finds its agent on the PATH the app gave it: the machine's row says it is ready (a new chat falls to another agent otherwise). */
const agentReady = (h: Harness, agent: string) =>
  expect
    .poll(async () => JSON.stringify(await thisMacRow(h)), { timeout: 90_000 })
    .toMatch(new RegExp(`"id":"${agent}"[^}]*"state":"ready"`));

test('J4 on Claude Code, on This Mac · keeps running: the agent asks, the card shows, the answer reaches it', async ({ harness }) => {
  const page = harness.page;
  await installThisMac(harness);
  await agentReady(harness, 'claude');
  await startChatOnThisMac(harness, 'ASKMULTI now');
  await answerTheQuestion(page, agents.claudeLog, hostLog);
  await expect(page.getByRole('main').getByText(/\[answers: /)).toBeVisible({ timeout: 60_000 });
  expect(JSON.stringify(logged(agents.claudeLog).filter((e) => e.kind === 'question')), 'the agent got the answer').toContain('a.ts');
  await pickerOffersOnly(page, 'Claude Code', /Kimi Code|Codex|opencode/);
  await page.keyboard.press('Escape');
  // a second message goes to the machine only: no error row from this Mac's own agent host (#4719)
  await send(page, 'second message now');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText(/Unknown harness/)).toHaveCount(0);
  await page.evaluate(() => window.native.host.removeLocal());
});

test('J4 on Codex, on This Mac · keeps running: the agent asks, the card shows, the answer reaches it', async ({ harness }) => {
  const page = harness.page;
  await installThisMac(harness);
  await agentReady(harness, 'codex');
  await startChatOnThisMac(harness, 'askfiles now', { localRow: 'Codex' });
  await answerTheQuestion(page, agents.codexLog, hostLog);
  await expect(page.getByRole('main').getByText(/files: .*a\.ts/)).toBeVisible({ timeout: 60_000 });
  await pickerOffersOnly(page, 'Codex', /Kimi Code|Claude Code|opencode/);
  await page.evaluate(() => window.native.host.removeLocal());
});
