// The Skills page's All harnesses tab end to end: a skill from an installed store plugin is listed once for every harness,
// opens its detail with where it is on, and the per-harness tabs stay. Screenshots land in the run's output for a look.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs } from './fixtures/app';

function seedMarketplace(d: Dirs) {
  const write = (file: string, text: string) => {
    const at = path.join(d.home, 'acme-market', file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text);
  };
  write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'acme', plugins: [{ name: 'notes-kit', source: './notes-kit' }] }));
  write('notes-kit/.claude-plugin/plugin.json', JSON.stringify({ name: 'notes-kit', version: '1.0.0' }));
  write('notes-kit/skills/tidy/SKILL.md', '---\nname: tidy\ndescription: Tidy notes\n---\nTidy them all.');
}

test.use({ harnesses: 'claude', seed: { files: seedMarketplace } });

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

test('Skills: All harnesses lists a plugin skill once, with its detail; the harness tabs stay', async ({ page, harness }) => {
  // install a plugin that brings one skill
  await page.getByRole('button', { name: 'Plugins' }).first().click();
  await page.locator('.plugin-store-bar .segmented button', { hasText: 'Discover' }).click();
  await page.getByRole('button', { name: 'Add marketplace' }).first().click();
  const add = page.getByRole('dialog', { name: 'Add marketplace' });
  await add.getByLabel('Marketplace source').fill(path.join(harness.env.HOME, 'acme-market'));
  await add.getByRole('button', { name: 'Add', exact: true }).last().click();
  await page.locator('.plugin-card', { hasText: 'Notes Kit' }).getByRole('button', { name: 'Install Notes Kit' }).click();
  const review = page.getByRole('dialog', { name: 'Install Notes Kit' });
  await review.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(review).toHaveCount(0);

  // Skills opens on All harnesses
  await page.getByRole('button', { name: 'Skills' }).first().click();
  await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('All harnesses');
  const card = page.locator('.plugin-card', { hasText: 'Tidy' });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Tidy notes');
  // Codex isn't here: that is not an error on the page
  await expect(page.locator('.plugins-page')).not.toContainText("Couldn't read");
  await shot(page, '1-all-skills');

  // its detail says where it is on and shows the SKILL.md
  await card.click();
  const detail = page.getByRole('dialog');
  await expect(detail).toContainText('Claude Code: on');
  await expect(detail).toContainText('Tidy them all.');
  await expect(detail.getByRole('button', { name: 'Try now' })).toBeVisible();
  await shot(page, '2-skill-detail');
  await detail.getByRole('button', { name: 'Close' }).click();

  // the per-harness tabs stay
  await page.locator('.ext-harness-tabs .segmented button', { hasText: 'Claude Code' }).click();
  await expect(page.locator('.plugins-page .page-title')).toHaveText('Skills');
  await shot(page, '3-claude-tab');
  await page.locator('.ext-harness-tabs .segmented button', { hasText: 'All harnesses' }).click();
  await expect(card).toHaveCount(1);
});
