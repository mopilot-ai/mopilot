// Automatic models outrank an old CLI pin and survive native receipts, explicit choices and a window reload.
// e2e-covers: src/session/harness/select.ts
// e2e-covers: src/components/harnessPicker/FirstTierPicker.tsx
// e2e-covers: electron/harness/codexTurns.cjs
// e2e-covers: electron/harness/claude/turnSettings.cjs
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

test.use({
  harnesses: 'both',
  seed: {
    files: ({ codexHome }) => fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "fake-model-2"\n'),
    uiState: { prefs: { model: null, claudeSelection: { model: null, effort: null, fast: false } } },
  },
});

const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

async function openModels(page: Page, harness: string) {
  await modelButton(page).click();
  await page.getByRole('button', { name: 'Select harness and model' }).click();
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
}

async function choose(page: Page, harness: string, model: string) {
  await openModels(page, harness);
  await page.locator('.hp-models').getByRole('menuitemradio', { name: model, exact: true }).click();
  await page.keyboard.press('Escape');
}

async function send(page: Page, text: string, reply: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText(`${reply}: ${text}`, { exact: true })).toBeVisible();
}

test('Codex automatically uses the recommendation over an old config pin and preserves Automatic after reload', async ({
  page,
  harness,
}) => {
  await expect(modelButton(page)).toContainText('Fake Model One');
  await send(page, 'automatic first', 'fake-codex');
  const started = (text: string) => harness.codexLog().find((e) => e.method === 'turn/start' && e.params.input?.[0]?.text === text)!.params;
  const threadId = started('automatic first').threadId;
  expect(started('automatic first')).toMatchObject({ model: 'fake-model-1', collaborationMode: { settings: { model: 'fake-model-1' } } });
  await choose(page, 'Codex', 'Fake Model Two');
  await send(page, 'manual version', 'fake-codex');
  expect(started('manual version').model).toBe('fake-model-2');
  await choose(page, 'Codex', 'Automatic');
  await send(page, 'automatic again', 'fake-codex');
  expect(started('automatic again').model).toBe('fake-model-1');
  await expect(page.getByRole('complementary').getByText('Fake chat title', { exact: true }).first()).toBeVisible();
  await page.reload();
  await page.getByRole('complementary').getByText('Fake chat title', { exact: true }).first().click();
  await expect(modelButton(page)).toContainText('Fake Model One');
  await openModels(page, 'Codex');
  await expect(page.locator('.hp-models').getByRole('menuitemradio', { name: 'Automatic', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await send(page, 'automatic after reload', 'fake-codex');
  expect(started('automatic after reload').model).toBe('fake-model-1');
  expect(started('automatic after reload').threadId).toBe(threadId);
});

test('Claude Automatic stays automatic after native model receipts and manual selection', async ({ page, harness }) => {
  await choose(page, 'Claude Code', 'Automatic');
  await send(page, 'automatic claude first', 'fake-claude');
  const used = (text: string) => harness.claudeLog().find((e) => e.kind === 'turn' && e.text === text)?.model;
  expect(used('automatic claude first')).toBe('claude-fake-opus');
  await choose(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'manual claude', 'fake-claude');
  expect(used('manual claude')).toBe('claude-fake-sonnet');
  await choose(page, 'Claude Code', 'Automatic');
  await send(page, 'automatic claude again', 'fake-claude');
  expect(used('automatic claude again')).toBe('claude-fake-opus');
  await openModels(page, 'Claude Code');
  await expect(page.locator('.hp-models').getByRole('menuitemradio', { name: 'Automatic', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
