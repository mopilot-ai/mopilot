// Remote Control on Claude Code (electron/harness/claude/remoteControl.cjs): the composer's switch and /remote-control link a running
// session to claude.ai through the SDK's remote_control request, the summary panel's Open opens the page that follows it, an
// off takes the link down, and a refusal is said. The composer draws no chip for it. Runs against fake-claude.mjs.
// e2e-covers: src/components/panels/SummaryEnvironment.tsx src/components/panels/SummaryPanel.tsx src/session/useRemoteControlRow.ts
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { captureExternal } from './fixtures/externalUrls';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const entry = (page: Page) => page.locator('.slash-panel .add-panel-item', { hasText: 'Remote Control' });
const chip = (page: Page) => page.locator('.plan-chip', { hasText: 'Remote Control' });
const open = (page: Page) => card(page).getByRole('button', { name: 'Open', exact: true });
// the summary panel's Remote Control row keeps the link's state in view, where a toast is gone in seconds
const card = (page: Page) => page.locator('.summary-header');
const cardSwitch = (page: Page) => card(page).getByRole('switch', { name: 'Remote Control' });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const requests = (h: Harness) =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'in' && e.msg.type === 'control_request' && e.msg.request.subtype === 'remote_control')
    .map((e) => (e as any).msg.request);

test.use({ harnesses: 'claude' });

test('the switch links the session, the card opens its page, and off takes the link down', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  await composer(page).fill('/remote');
  await expect(entry(page)).toContainText('Follow this chat from claude.ai or the Claude app');
  await entry(page).click();
  await expect.poll(() => requests(harness).map((r) => r.enabled)).toEqual([true]);
  expect(requests(harness)[0].keep_session_on_exit).toBe(true);
  await expect(chip(page)).toHaveCount(0);
  await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(card(page)).toContainText('Linked to claude.ai');

  const opened = await captureExternal(harness);
  await open(page).click();
  await expect.poll(opened).toEqual(['https://claude.ai/code/session_fake']);

  // the menu shows it on, and picking it again turns it off
  await composer(page).fill('/remote');
  await expect(entry(page).locator('.add-panel-check')).toHaveCount(1);
  await expect(entry(page)).toContainText('Linked to claude.ai');
  await entry(page).click();
  await expect.poll(() => requests(harness).map((r) => r.enabled)).toEqual([true, false]);
  await expect(open(page)).toHaveCount(0);
  await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'false');
});

test.describe('a login that cannot have a bridge', () => {
  test.use({ env: { FAKE_CLAUDE_NO_REMOTE_CONTROL: '1' } });

  test('the refusal is said, and the card has nothing to open', async ({ page, harness }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await send(page, 'warm up');
    await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();
    await composer(page).fill('/remote');
    await entry(page).click();
    await expect.poll(() => requests(harness).length).toBe(1);
    // the refusal is said in a toast and stays on the card, whose switch is off and can be pressed again (it is an error, not an unavailable login)
    await expect(card(page).getByText('Remote Control is not available')).toBeVisible();
    await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(cardSwitch(page)).toBeEnabled();
    await expect(chip(page)).toHaveCount(0);
    await expect(open(page)).toHaveCount(0);
  });
});

// the reaper ends an idle CLI an hour after its last turn; MOPILOT_REAPER_TEST lets the test sweep as if hours had passed
test.describe('the idle reaper', () => {
  test.use({ env: { MOPILOT_REAPER_TEST: '1' } });

  const sweep = (h: Harness, hours: number) => h.app.evaluate((_e, ms) => (globalThis as any).__claudeReap(ms), hours * 60 * 60_000);
  const starts = (h: Harness) => h.claudeLog().filter((e: any) => e.kind === 'argv' && e.argv.includes('stream-json')).length;

  test('leaves a CLI whose link is wanted alone, and ends it once the link is off', async ({ page, harness }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await send(page, 'warm up');
    await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();
    const started = starts(harness);

    await composer(page).fill('/remote');
    await entry(page).click();
    await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'true');

    // hours later the link is still up, and the next message goes to the same CLI
    await sweep(harness, 3);
    await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(card(page)).toContainText('Linked to claude.ai');
    await send(page, 'still here');
    await expect(transcript(page).getByText('fake-claude: still here', { exact: true })).toBeVisible();
    expect(starts(harness)).toBe(started);

    // with the link off the same sweep ends the CLI, and the next message starts it again
    await composer(page).fill('/remote');
    await entry(page).click();
    await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await sweep(harness, 3);
    await send(page, 'back again');
    await expect(transcript(page).getByText('fake-claude: back again', { exact: true })).toBeVisible();
    await expect.poll(() => starts(harness)).toBe(started + 1);
  });
});

test.describe('a bridge the CLI takes down', () => {
  test.use({ env: { FAKE_CLAUDE_BRIDGE_DROPS: '1' } });

  test('is reattached on its own, and the link stays on', async ({ page, harness }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await send(page, 'warm up');
    await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();
    await composer(page).fill('/remote');
    await entry(page).click();
    // the CLI ends the first bridge soon after it is up (worker_shutting_down); the app asks for it back on the same bridge
    await expect.poll(() => requests(harness).map((r) => r.enabled)).toEqual([true, true]);
    expect(requests(harness)[1].reattach_session_id).toBe('cse_fake');
    await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(card(page)).toContainText('Linked to claude.ai');
  });
});
