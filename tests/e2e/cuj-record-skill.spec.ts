// CUJ record-a-skill on both harnesses, against a fake computer-use helper: the composer's + menu → Record a skill → Start shows the recording pill, the
// person's clicks and keys (the helper's record.event) are kept while it shows, Done attaches the recording to the composer as a chip with a first line
// asking for a skill, and the message goes out; a second recording is discarded and attaches nothing.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { remoteFlags } from './fixtures/flags';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const composerStop = (page: Page) => page.locator('button.send-btn.stop');
const MAIL = { bundleId: 'com.apple.mail', name: 'Mail' };

/** The recording pill's window (its own page, titled by the pill). */
async function pill(harness: Harness) {
  let found: Page | null = null;
  await expect
    .poll(async () => {
      for (const p of harness.app.windows()) {
        if ((await p.title().catch(() => '')) === 'MoPilot recording') {
          found = p;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return found as unknown as Page;
}

async function startRecording(page: Page) {
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel-item', { hasText: 'Record a skill' }).click();
  await expect(
    page.getByText('Your clicks and typing are recorded, then sent to this chat to turn into a repeatable skill.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toHaveCount(0);
}

async function journey(page: Page, harness: Harness) {
  const helper = harness.helper!;
  await expect(home(page)).toBeVisible();

  // 1. Start: the helper records, the pill shows
  await startRecording(page);
  await expect.poll(() => helper.log.filter((m) => m.method === 'record.start').length).toBe(1);
  const recording = await pill(harness);
  await expect(recording.locator('#label')).toContainText('Recording');
  await expect(recording.getByRole('link', { name: 'Done' })).toBeVisible();

  // 2. what the person does is kept: a click on a button, then some typing
  helper.record({
    t: 1200,
    kind: 'click',
    button: 'left',
    count: 1,
    x: 40,
    y: 50,
    app: MAIL,
    element: { role: 'AXButton', label: 'New Message' },
    window: 'Inbox',
  });
  helper.record({ t: 2400, kind: 'key', text: 'Hello', app: MAIL });
  helper.record({ t: 2600, kind: 'key', combo: 'cmd+return', app: MAIL });

  // 3. Done: the recording is a chip on the composer with a first line asking for a skill
  await recording.getByRole('link', { name: 'Done' }).click({ noWaitAfter: true });
  await expect.poll(() => helper.log.filter((m) => m.method === 'record.stop').length).toBe(1);
  await expect(page.locator('.attachment-name')).toHaveText('Recording · 3 steps');
  await expect(composer(page)).toHaveText('Turn this recording into a skill.');

  // 4. the message goes out, and the turn ends
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composerStop(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('main').getByText('Turn this recording into a skill.').first()).toBeVisible();
}

async function discardJourney(page: Page, harness: Harness) {
  const helper = harness.helper!;
  await expect(home(page)).toBeVisible();
  await startRecording(page);
  const recording = await pill(harness);
  helper.record({ t: 100, kind: 'key', text: 'x', app: MAIL });
  await recording.getByRole('link', { name: 'Discard' }).click({ noWaitAfter: true });
  await expect.poll(() => helper.log.filter((m) => m.method === 'record.stop').length).toBe(1);
  await expect(page.locator('.attachment-name')).toHaveCount(0);
  await expect(composer(page)).toHaveText('');
}

test.describe('Codex, record a skill', () => {
  test.use({ harnesses: 'codex', computerHelper: true, seed: { files: remoteFlags({ 'native.codex.enabled': false }) } });
  test('record a skill on Codex: the pill, the kept clicks and keys, Done attaches the recording and the message goes out', async ({
    page,
    harness,
  }) => {
    await journey(page, harness);
  });
  test('record a skill on Codex: Discard attaches nothing', async ({ page, harness }) => {
    await discardJourney(page, harness);
  });
});

test.describe('Claude Code, record a skill', () => {
  test.use({ harnesses: 'claude', computerHelper: true });
  test('record a skill on Claude Code: the pill, the kept clicks and keys, Done attaches the recording and the message goes out', async ({
    page,
    harness,
  }) => {
    await journey(page, harness);
  });
  test('record a skill on Claude Code: Discard attaches nothing', async ({ page, harness }) => {
    await discardJourney(page, harness);
  });
});
