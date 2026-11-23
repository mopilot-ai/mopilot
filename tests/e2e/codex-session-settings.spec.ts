// Codex session settings in the real app (WP5-6, A5, A25) against fake-codex.mjs: model, effort and
// Fast belong to each chat (D-29), Ultra shows only on a model that lists it, Fast only on a model
// with the priority tier (D-57), and "Fork chat from here" forks through that turn (D-62).
import { standaloneNewChat } from './fixtures/sidebar';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(`fake-codex: ${text}`, { exact: true })).toBeVisible();
}
async function pickModel(page: Page, model: string) {
  await modelButton(page).click();
  await page.getByRole('button', { name: 'Select harness and model' }).click();
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await expect(modelButton(page)).toContainText(model);
}
/** The model menu with its effort slider and Fast toggle (still open right after picking a model). */
async function openEffort(page: Page) {
  if (!(await page.locator('.effort-pop').isVisible())) await modelButton(page).click();
  await expect(page.locator('.effort-pop')).toBeVisible();
}
/**
 * The Fast toggle's tooltip opens on mouseenter, an edge: a pointer that was already over the button
 * while the menu animated in (or a menu that moved under it) gives no enter. Leave and enter again until
 * the tooltip is there.
 */
async function hoverFast(page: Page, tip: string | RegExp, force = false) {
  const toggle = page.getByRole('button', { name: 'Toggle fast mode' });
  await expect(async () => {
    await page.mouse.move(1, 1);
    await toggle.hover({ force });
    await expect(page.getByText(tip)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
}
const turnStart = (h: Harness, text: string) =>
  h.codexLog().find((e) => e.method === 'turn/start' && e.params.input?.[0]?.text === text)!.params;

test('codex-session-settings: two chats keep their own model, effort and Fast; Ultra and Fast follow the model', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'chat A one');
  await pickModel(page, 'Fake Model Two');
  // model two lists "ultra": the effort slider has it; model one doesn't
  await openEffort(page);
  await expect(page.locator('.effort-dot')).toHaveCount(3);
  await page.locator('.effort-pop').press('ArrowRight');
  await page.locator('.effort-pop').press('ArrowRight');
  await expect(page.locator('.effort-name')).toHaveText('Ultra');
  // no priority tier on model two: no Fast
  await expect(page.getByRole('button', { name: 'Toggle fast mode' })).toBeDisabled();
  // the reason is main's (model layer), in the copy table's words
  await hoverFast(page, "This model doesn't support Fast · Switch model", true);
  await page.keyboard.press('Escape');

  // every pick in a chat is also the new-chat default: a new chat starts on chat A's model and effort
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await expect(modelButton(page)).toContainText('Fake Model Two');
  await send(page, 'chat B one');
  expect(turnStart(harness, 'chat B one')).toMatchObject({ model: 'fake-model-2', effort: 'ultra' });
  // chat B picks its own model: model one has no Ultra, and has Fast
  await pickModel(page, 'Fake Model One');
  await openEffort(page);
  await expect(page.locator('.effort-dot')).toHaveCount(2);
  const fastToggle = page.getByRole('button', { name: 'Toggle fast mode' });
  await expect(fastToggle).toBeEnabled();
  await fastToggle.click();
  await page.keyboard.press('Escape');
  await send(page, 'chat B two');
  expect(turnStart(harness, 'chat B two')).toMatchObject({ serviceTier: 'priority' });
  expect(turnStart(harness, 'chat B two').model ?? null).not.toBe('fake-model-2');

  // chat A kept its own, and B's Fast didn't reach it
  await sidebar(page).getByText('Fake chat title', { exact: true }).nth(1).click();
  await expect(transcript(page).getByText('fake-codex: chat A one', { exact: true })).toBeVisible();
  await expect(modelButton(page)).toContainText('Fake Model Two');
  await send(page, 'chat A two');
  const a2 = turnStart(harness, 'chat A two');
  expect(a2).toMatchObject({ model: 'fake-model-2', effort: 'ultra' });
  expect(a2.serviceTier).not.toBe('priority');
});

test('codex-fork: Fork chat from here forks through that turn, holding the goal back', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'first turn');
  await send(page, 'second turn');
  const threadId = harness.codexLog().find((e) => e.method === 'turn/start' && e.params.input?.[0]?.text === 'first turn')!.params
    .threadId as string;
  await transcript(page).getByRole('button', { name: 'Fork chat from here' }).first().click();
  await expect(page.getByText('Forked into a new chat')).toBeVisible();
  const fork = harness.codexLog().find((e) => e.method === 'thread/fork')!.params;
  expect(fork).toMatchObject({ threadId: threadId, deferGoalContinuation: true, excludeTurns: true });
  expect(typeof fork.lastTurnId).toBe('string');
  await expect(transcript(page).getByText('fake-codex: first turn', { exact: true })).toBeVisible();
  await expect(transcript(page).getByText('fake-codex: second turn', { exact: true })).toHaveCount(0);
});

const NOTE = 'On an API key, Fast is billed at the higher priority rate';

test('codex-session-settings: Fast says nothing extra on a ChatGPT login (D-57)', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'plain login');
  await openEffort(page);
  await hoverFast(page, 'Enable fast mode');
  await expect(page.getByText(NOTE)).toHaveCount(0);
});

test.describe('API key', () => {
  test.use({ env: { FAKE_CODEX_AUTH: 'api-key' } });

  test('codex-session-settings: on an API key the Fast tooltip and the / menu carry the billing note (D-57)', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'keyed');
    await openEffort(page);
    await hoverFast(page, `Enable fast mode · ${NOTE}`);
    await page.keyboard.press('Escape');
    await composer(page).fill('/fast');
    await expect(page.locator('.slash-panel .add-panel-item', { hasText: 'Fast' })).toContainText(NOTE);
  });
});
