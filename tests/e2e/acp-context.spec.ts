// A basic harness's context report fills the quick view; context details mark estimates and Status never invents prompt totals.
// e2e-covers: src/components/composer/ContextRing.tsx src/components/context/LazyContextPanel.tsx src/components/context/ContextPanel.tsx
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { standaloneNewChat } from './fixtures/sidebar';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(`fake-acp: ${text}`, { exact: true })).toBeVisible();
}

// the fake sends usage_update { used: 1000 × (prompts so far + 1), size: 200000 } and no prompt usage
test.use({ harnesses: 'codex', acp: { kimi: { usage: true } } });

test('a basic chat: the ring and panel read its usage_update; Status names no total it never reported', async ({ page }) => {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await page.getByRole('button', { name: /^Select (model|harness)$/ }).click();
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  if (await toList.isVisible().catch(() => false)) await toList.click();
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await send(page, 'first message');
  await send(page, 'second message');

  const ring = page.locator('.context-ring');
  await expect(ring).toHaveAttribute('aria-label', 'Context: 1% used, 2k of 200k tokens');
  await ring.click();
  const panel = page.locator('.ctx-popover');
  await expect(panel.locator('.ctx-summary-value')).toHaveText('1% used');
  await expect(panel.getByRole('meter')).toHaveAttribute('aria-valuetext', '1% used, 2k of 200k tokens');
  await expect(panel.locator('.ctx-legend, .ctx-compact')).toHaveCount(0);
  await panel.getByRole('button', { name: 'View context', exact: true }).click();
  const context = page.locator('.dialog', { has: page.getByText('Context', { exact: true }) });
  // token counts only: the split is marked estimated, and no reserve or auto-compact mark a harness did not send
  await expect(context.locator('.ctx-cat', { hasText: 'Instructions & tools' }).locator('.ctx-est')).toHaveText('est.');
  await expect(context.locator('.ctx-mark')).toHaveCount(0);

  await context.getByRole('button', { name: 'Chat details' }).click();
  const status = page.locator('.dialog', { has: page.getByText('Status', { exact: true }) });
  await expect(status.locator('.status-row', { hasText: 'Context' })).toContainText('1% used · 2k / 200k tokens');
  // it reported no prompt usage: no total, never the 2,000 tokens of context it holds
  await expect(status.locator('.status-row', { hasText: 'Total tokens' })).toContainText('—');
});
