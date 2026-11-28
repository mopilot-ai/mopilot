// A Claude Code safety check asks even in Full access; its card says why (decisionReason) under the command's own description,
// so a full-access user sees why Claude Code asked: tests/e2e/fixtures/fake-claude-asks.mjs (SAFETYASK) asks as Claude Code 2.1.330 does.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SAFETY_REASON } from './fixtures/fake-claude-asks.mjs';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

test.use({ harnesses: 'both' });

test("a safety-check card in Full access shows Claude Code's reason under the command's description", async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await page.getByRole('button', { name: 'Change permissions' }).click();
  await page.locator('.perm-menu .perm-item.full-access').click();

  await composer(page).fill('SAFETYASK go');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.locator('.approval-card');
  await expect(card.locator('.approval-message')).toHaveText('Rewrite basic picker tests and run');
  await expect(card.locator('.approval-why')).toHaveText(SAFETY_REASON);
  await page.screenshot({ path: test.info().outputPath('safety-ask-card.png') });

  await card.getByRole('button', { name: /Allow once/ }).click();
  await expect(page.getByRole('main').getByText(/fake-claude: SAFETYASK go \[safety: allow\]/)).toBeVisible();
  const turn = harness.claudeLog().find((e: any) => e.kind === 'turn' && e.text === 'SAFETYASK go') as any;
  expect(turn?.mode).toBe('bypassPermissions');
});
