// CUJ teach mode and full control on the desktop_* tools (mopilot_computer on Claude Code), against a fake
// computer-use helper: the agent asks to guide the user through a task (one card, in the teach wording), the tooltip
// window shows each step with Exit and Next, Next runs the step's actions on the screen and the next tooltip follows,
// Exit ends the tour; and the agent asks for full-screen control up front (the takeover card), uses the screen with no
// second card, releases it, and is asked again.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { remoteFlags } from './fixtures/flags';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');
const composerStop = (page: Page) => page.locator('button.send-btn.stop');

async function sendLines(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toContainText(lines[lines.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

interface Way {
  who: 'Codex' | 'Claude Code';
  call(name: string, args: object): string;
  steps: string;
}
const CLAUDE: Way = {
  who: 'Claude Code',
  call: (name, args) => `CUCALL mcp__mopilot_computer__${name.replace(/^desktop_/, '')} ${JSON.stringify(args)}`,
  steps: 'CUSTEPS',
};
const CODEX: Way = { who: 'Codex', call: (name, args) => `MCPCU ${name} ${JSON.stringify(args)}`, steps: 'go' };

/** The tooltip's window (its own page, titled by the teach overlay), once it shows `text`. */
async function tooltip(harness: Harness, text: string) {
  let found: Page | null = null;
  await expect
    .poll(async () => {
      for (const p of harness.app.windows()) {
        if ((await p.title().catch(() => '')) !== 'MoPilot teach tooltip') continue;
        if (
          ((await p
            .locator('#say')
            .textContent()
            .catch(() => '')) ?? '') !== text
        )
          continue;
        found = p;
        return true;
      }
      return false;
    })
    .toBe(true);
  return found as unknown as Page;
}

async function teachJourney(page: Page, harness: Harness, w: Way) {
  const helper = harness.helper!;
  const log = (method: string) => helper.log.filter((m) => m.method === method);
  await expect(home(page)).toBeVisible();

  // 1. one card, in the teach wording; Allow in this chat
  await sendLines(page, [
    w.call('desktop_request_teach_access', { apps: ['Notes'], reason: 'tidy your notes' }),
    w.call('desktop_screenshot', {}),
    w.call('desktop_teach_step', {
      explanation: 'This is your Notes window',
      next_preview: "Next: I'll click it",
      anchor: [0, 0],
      actions: [{ action: 'left_click', coordinate: [0, 0] }],
    }),
    w.call('desktop_teach_step', { explanation: 'All set', next_preview: 'Next: nothing, this is the last step', actions: [] }),
    w.steps,
  ]);
  await expect(card(page)).toHaveAttribute('data-kind', 'computerAccessSet');
  await expect(card(page)).toContainText(`Allow ${w.who} to guide you through tidy your notes?`);
  await pickScope(card(page), /^Allow in this chat/);

  // 2. the first tooltip: the words, the preview, Exit and Next; nothing has been clicked yet
  const first = await tooltip(harness, 'This is your Notes window');
  await expect(first.locator('#preview')).toHaveText("Next: I'll click it");
  await expect(first.getByRole('link', { name: 'Exit' })).toBeVisible();
  expect(log('input.click')).toHaveLength(0);

  // 3. Next runs the step's click on the screen; the second tooltip follows
  await first.getByRole('link', { name: 'Next' }).click({ noWaitAfter: true });
  await expect.poll(() => log('input.click').length).toBe(1);
  const second = await tooltip(harness, 'All set');

  // 4. Exit ends the tour: the agent is told, the tooltip goes, the turn finishes
  await second.getByRole('link', { name: 'Exit' }).click({ noWaitAfter: true });
  await expect(transcript(page).getByText(/"exited":true/)).toBeVisible();
  await expect(composerStop(page)).toHaveCount(0, { timeout: 30_000 });
  expect(log('input.click')).toHaveLength(1);
}

async function fullControlJourney(page: Page, harness: Harness, w: Way) {
  const helper = harness.helper!;
  const log = (method: string) => helper.log.filter((m) => m.method === method);
  await expect(home(page)).toBeVisible();
  const point = { coordinate: [0, 0] };

  // 1. the apps first, with no mouse and keyboard on the card; then full control asked up front, with its reason
  await sendLines(page, [
    w.call('desktop_request_access', { apps: ['Notes'], reason: 'Look at the notes' }),
    w.call('desktop_screenshot', {}),
    w.call('desktop_request_full_control', {}),
    w.call('desktop_left_click', point),
    w.call('desktop_release_full_control', {}),
    w.call('desktop_left_click', point),
    w.steps,
  ]);
  await expect(card(page)).toHaveAttribute('data-kind', 'computerAccessSet');
  await pickScope(card(page), /^Allow in this chat/);
  await expect(card(page)).toHaveAttribute('data-kind', 'computerTakeover');
  await expect(card(page)).toContainText(`Allow ${w.who} to use your mouse and keyboard in Notes?`);
  await expect(card(page)).toContainText('needs the real pointer and keyboard');
  await card(page)
    .getByRole('button', { name: /^Allow/ })
    .click();

  // 2. the click runs with no second card; after the release the next click asks again
  await expect.poll(() => log('input.click').length).toBe(1);
  await expect.poll(() => log('control.release').length).toBeGreaterThanOrEqual(1);
  await expect(card(page)).toHaveAttribute('data-kind', 'computerTakeover');
  await card(page)
    .getByRole('button', { name: /^Allow/ })
    .click();
  await expect.poll(() => log('input.click').length).toBe(2);
  await expect(composerStop(page)).toHaveCount(0, { timeout: 30_000 });
}

test.describe('Codex, teach mode', () => {
  test.use({ harnesses: 'codex', computerHelper: true, seed: { files: remoteFlags({ 'native.codex.enabled': false }) } });
  test('teach mode on Codex: the teach card, tooltips with Next and Exit, the click on Next', async ({ page, harness }) => {
    await teachJourney(page, harness, CODEX);
  });
  test('full control on Codex: asked up front, used without a second card, released and asked again', async ({ page, harness }) => {
    await fullControlJourney(page, harness, CODEX);
  });
});

test.describe('Claude Code, teach mode', () => {
  test.use({ harnesses: 'claude', computerHelper: true });
  test('teach mode on Claude Code: the teach card, tooltips with Next and Exit, the click on Next', async ({ page, harness }) => {
    await teachJourney(page, harness, CLAUDE);
  });
  test('full control on Claude Code: asked up front, used without a second card, released and asked again', async ({ page, harness }) => {
    await fullControlJourney(page, harness, CLAUDE);
  });
});
