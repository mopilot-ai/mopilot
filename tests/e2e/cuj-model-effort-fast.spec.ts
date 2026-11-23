// CUJ model-effort-fast on both harnesses: pick a model, move the effort slider, Fast where the model has it
// (the reason where it does not, none on an account without Fast), reset to the default, see the model change in the chat, and read the
// context and model in /status.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

async function send(page: Page, text: string, reply: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(`${reply}: ${text}`, { exact: true })).toBeVisible();
}
async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await modelButton(page).click();
  await page.getByRole('button', { name: 'Select harness and model' }).click();
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await expect(modelButton(page)).toContainText(model);
}
/** The model menu with its effort slider (still open right after picking a model). */
async function openEffort(page: Page) {
  if (!(await page.locator('.effort-pop').isVisible())) await modelButton(page).click();
  await expect(page.locator('.effort-pop')).toBeVisible();
}
async function openStatus(page: Page) {
  await composer(page).fill('/status');
  await page.keyboard.press('Enter');
  const dialog = page.locator('.dialog', { hasText: 'Status' });
  await expect(dialog).toBeVisible();
  return dialog;
}
const turnStart = (h: Harness, text: string) =>
  h.codexLog().find((e) => e.method === 'turn/start' && e.params.input?.[0]?.text === text)!.params;

test.use({ harnesses: 'both' });

test('model-effort-fast on Codex: model, effort, Fast, reset, /status', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'first', 'fake-codex');
  await pickModel(page, 'Codex', 'Fake Model Two');
  await openEffort(page);
  // this model lists Ultra: the slider has three stops, and Fast is off for it with its reason
  await expect(page.locator('.effort-dot')).toHaveCount(3);
  await page.locator('.effort-pop').press('ArrowRight');
  await page.locator('.effort-pop').press('ArrowRight');
  await expect(page.locator('.effort-name')).toHaveText('Ultra');
  await expect(page.getByRole('button', { name: 'Toggle fast mode' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await send(page, 'second', 'fake-codex');
  expect(turnStart(harness, 'second')).toMatchObject({ model: 'fake-model-2', effort: 'ultra' });
  // a per-chat model pick is marked in the chat, as on Claude
  await expect(transcript(page).locator('.status-note')).toContainText('Model changed to Fake Model Two');

  // Reset to default: only the effort, back to the model's default; the model stays
  await openEffort(page);
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await expect(page.locator('.effort-name')).toHaveText('Medium');
  await page.keyboard.press('Escape');
  await expect(modelButton(page)).toContainText('Fake Model Two');
  // the first model has the priority tier: Fast on
  await pickModel(page, 'Codex', 'Fake Model One');
  await openEffort(page);
  await page.getByRole('button', { name: 'Toggle fast mode' }).click();
  await expect(page.getByRole('button', { name: 'Toggle fast mode' })).toHaveClass(/on/);
  await page.keyboard.press('Escape');
  await send(page, 'third', 'fake-codex');
  expect(turnStart(harness, 'third')).toMatchObject({ serviceTier: 'priority' });

  // this model lists two service tiers: the picker offers each with the model's own note, and the choice reaches the turn
  await openEffort(page);
  const tiers = page.getByRole('radiogroup', { name: 'Speed' });
  await expect(tiers.getByRole('radio')).toHaveCount(3);
  await expect(tiers.getByRole('radio', { name: /Standard/ })).toContainText('Default speed and rate');
  await expect(tiers.getByRole('radio', { name: /Fast/ })).toContainText('1.5x speed, 2x credits');
  await expect(tiers.getByRole('radio', { name: /Fast/ })).toHaveAttribute('aria-checked', 'true');
  await tiers.getByRole('radio', { name: /Flex/ }).click();
  await expect(tiers.getByRole('radio', { name: /Flex/ })).toContainText('Slower, half the credits');
  await expect(tiers.getByRole('radio', { name: /Flex/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await send(page, 'fourth', 'fake-codex');
  expect(turnStart(harness, 'fourth')).toMatchObject({ serviceTier: 'flex' });

  // /status: chat, model and where the context stands
  const status = await openStatus(page);
  await expect(status).toContainText('Fake Model One');
  await expect(status).toContainText('Codex');
  await status.getByRole('button', { name: 'Close' }).click();
  await expect(status).toHaveCount(0);
});

test('switching Claude Code models over a full context names no window the new model was never reported to have', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Opus');
  // a turn that fills 300k tokens of the 200k window this model reports
  await send(page, 'first CTXOVER', 'fake-claude');
  // every toast that shows, kept as it appears: an error toast goes in seconds, before a retrying assertion could miss it
  await page.evaluate(() => {
    const seen: string[] = ((window as any).__toasts = []);
    new MutationObserver(() => {
      for (const t of document.querySelectorAll('.toast')) if (!seen.includes(t.textContent ?? '')) seen.push(t.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'second', 'fake-claude');
  // the change is shown, and no toast claims a window size for a model that has not reported one
  await expect(transcript(page).locator('.status-note')).toContainText('Fake Sonnet');
  expect(await page.evaluate(() => (window as any).__toasts)).toEqual([]);
});

test('model-effort-fast on Claude Code: model, effort, no Fast on an account without it, reset, the change shown in the chat, /status', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Opus');
  await send(page, 'first', 'fake-claude');
  // a model other than the harness default (Fake Opus): Reset to default must keep it
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await openEffort(page);
  await expect(page.locator('.effort-dot')).toHaveCount(3);
  await page.locator('.effort-pop').press('ArrowRight');
  const effort = await page.locator('.effort-name').innerText();
  // the fake's account has extra usage off: no Fast toggle at all (fast-ineligible-account.spec.ts covers it on a Fast model)
  await expect(page.getByRole('button', { name: 'Toggle fast mode' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await send(page, 'second', 'fake-claude');
  await expect(transcript(page).locator('.status-note')).toContainText('Fake Sonnet');
  // the new model and effort reached the CLI session
  await expect
    .poll(() =>
      harness
        .claudeLog()
        .filter(
          (e) =>
            e.kind === 'in' && e.msg?.type === 'control_request' && ['set_model', 'apply_flag_settings'].includes(e.msg.request?.subtype),
        )
        .map((e) => JSON.stringify((e as any).msg.request)),
    )
    .toEqual(expect.arrayContaining([expect.stringContaining('sonnet')]));
  expect(effort.length).toBeGreaterThan(0);

  // Reset to default resets only the effort: the model stays Fake Sonnet
  await openEffort(page);
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await page.keyboard.press('Escape');
  await expect(modelButton(page)).toContainText('Fake Sonnet');
  await expect(modelButton(page)).not.toContainText('Fake Opus');

  const status = await openStatus(page);
  await expect(status).toContainText('Claude Code');
  await status.getByRole('button', { name: 'Close' }).click();
  await expect(status).toHaveCount(0);
});
