// The shared Plugins page end to end: installed cards, a marketplace added from its dialog, the review before an
// install, a plugin's page with its per-harness switches, and Uninstall after asking. Screenshots land in the run's
// output for a look at the layout. The marketplace is a local folder; nothing here reaches the network.
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
  write(
    '.claude-plugin/marketplace.json',
    JSON.stringify({
      name: 'acme',
      plugins: [{ name: 'notes-kit', description: 'Keeps your notes tidy.', author: { name: 'Acme' }, source: './notes-kit' }],
    }),
  );
  write(
    'notes-kit/.claude-plugin/plugin.json',
    JSON.stringify({ name: 'notes-kit', version: '1.2.0', description: 'Keeps your notes tidy.' }),
  );
  write('notes-kit/skills/tidy/SKILL.md', '---\nname: tidy\ndescription: Tidy notes\n---\nTidy them.');
  write('notes-kit/hooks/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stopped' }] }] } }));
}

// Claude Code alone: the fake Codex doesn't take the mirror's installs, so every card would say it couldn't install there
test.use({ harnesses: 'claude', seed: { files: seedMarketplace } });

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
const seg = async (page: Page, name: string) => {
  await page.locator('.plugin-store-bar .segmented button', { hasText: name }).click();
  await expect(page.locator('.plugin-store-bar .segmented button.on')).toHaveText(name);
};

test('Plugins: add a marketplace, review and install, one switch on the card, the rest on its page', async ({ page, harness }) => {
  await page.getByRole('button', { name: 'Plugins' }).first().click();
  await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('All harnesses');

  // MoPilot's own plugins: readable, one switch each, nothing about delivery internals
  const own = page.locator('.plugin-card', { hasText: 'MoPilot' });
  await expect(own).toContainText('Built in');
  await expect(own.getByRole('switch')).toHaveCount(1);
  await expect(page.locator('.plugins-page')).not.toContainText('Everything');
  await expect(page.locator('.plugins-page')).not.toContainText('ACP');
  await shot(page, '1-installed');

  // no marketplace yet: Discover leads to adding one
  await seg(page, 'Discover');
  await expect(page.getByText('No marketplaces yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add marketplace' }).first().click();
  const add = page.getByRole('dialog', { name: 'Add marketplace' });
  await expect(add.getByText('Anthropic plugins')).toBeVisible();
  await shot(page, '2-add-marketplace');
  await add.getByLabel('Marketplace source').fill(path.join(harness.env.HOME, 'acme-market'));
  await add.getByRole('button', { name: 'Add', exact: true }).last().click();
  await expect(add).toHaveCount(0);

  // the card, then the review
  const card = page.locator('.plugin-card', { hasText: 'Notes Kit' });
  await expect(card).toContainText('by Acme');
  await shot(page, '3-discover');
  await card.getByRole('button', { name: 'Install Notes Kit' }).click();
  const review = page.getByRole('dialog', { name: 'Install Notes Kit' });
  await expect(review).toContainText('Includes 1 skill');
  await expect(review).toContainText('Runs on this Mac:');
  await expect(review.locator('.plugin-trust-section > .plugin-trust-runs')).toHaveText('echo stopped');
  await expect(review.getByText('Full configuration')).toBeVisible();
  await expect(review).not.toContainText('mopilot-selected-mcp');
  await expect(review).not.toContainText('codex-0.');
  await shot(page, '4-review');
  await review.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(review).toHaveCount(0);

  // installed: one exception, not one line per harness; the sidebar lists it
  await seg(page, 'Installed');
  const installed = page.locator('.plugin-card', { hasText: 'Notes Kit' });
  await expect(installed).toContainText('Partly on Other agents');
  await expect(installed.getByRole('switch')).toHaveCount(1);
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Notes Kit' })).toBeVisible();
  await shot(page, '5-installed-with-plugin');

  // its page: a line and a switch per harness
  await installed.click();
  await expect(page.locator('.pd-title')).toHaveText('Notes Kit');
  await expect(page.locator('.pd-sub')).toContainText('v1.2.0');
  const harnesses = page.locator('.plugin-harness');
  await expect(harnesses).toHaveCount(3);
  await expect(harnesses.filter({ hasText: 'Other agents' })).toContainText("doesn't run plugin hooks");
  await shot(page, '6-plugin-page');
  await harnesses.filter({ hasText: 'Claude Code' }).getByRole('switch').click();
  await expect(harnesses.filter({ hasText: 'Claude Code' })).toContainText('Off');

  // Uninstall asks, then goes back to the list
  await page.locator('.pd-actions').getByRole('button', { name: 'Uninstall' }).click();
  const confirm = page.getByRole('dialog', { name: 'Uninstall Notes Kit?' });
  await shot(page, '7-confirm-uninstall');
  await confirm.getByRole('button', { name: 'Uninstall' }).click();
  await expect(page.locator('.plugin-store-bar')).toBeVisible();
  await expect(page.locator('.plugin-card', { hasText: 'Notes Kit' })).toHaveCount(0);

  // the marketplace stays until it is removed, which asks too
  await seg(page, 'Marketplaces');
  await page.locator('.settings-row', { hasText: 'acme' }).getByRole('button', { name: 'Remove' }).click();
  await shot(page, '8-marketplaces-remove');
  await page.getByRole('dialog', { name: 'Remove acme?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.settings-row', { hasText: 'acme' })).toHaveCount(0);
});
