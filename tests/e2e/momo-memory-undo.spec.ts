// MoMo's memory history (#2139 P3), on fake harnesses only, for an invited account (MOPILOT_MOMO_DEV=1) past setup: a fact
// added and edited in the Memory tab shows in Recent changes (who, what it did); Undo takes the edit back and marks it
// Undone; an Undo of a change whose fact changed since is refused with the reason, and the fact keeps its newer text;
// Settings › MoMo › Brain shows the background memory pass's limits. Screenshots of the tab and the row are saved.
import { test, expect } from './fixtures/app';
import { goToMomoSettings, goToMomoView, momoSetupDone, openMomo, settingsGroup } from './fixtures/momo';

test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' }, seed: momoSetupDone });

test('Recent changes lists each change with Undo; Undo reverts an edit, and refuses one whose fact changed since', async ({ page }) => {
  await openMomo(page, { setup: 'stay' });
  await goToMomoView(page, 'Memory');
  const facts = settingsGroup(page, 'Facts');
  const changes = settingsGroup(page, 'Recent changes');
  await expect(changes.getByText('No changes yet')).toBeVisible();

  // add a fact, then edit it
  await page.getByRole('textbox', { name: 'Add a fact', exact: true }).fill('Prefers tea');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(facts.getByText('Prefers tea', { exact: true })).toBeVisible();
  // by id: in edit mode the row's text is inside its textarea, which a text filter doesn't see
  const id = await facts.locator('.momo-fact').filter({ hasText: 'Prefers tea' }).getAttribute('data-fact');
  const fact = facts.locator(`.momo-fact[data-fact="${id}"]`);
  await fact.getByRole('button', { name: 'Edit', exact: true }).click();
  await fact.getByRole('textbox', { name: 'Fact', exact: true }).fill('Prefers green tea');
  await fact.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(facts.getByText('Prefers green tea', { exact: true })).toBeVisible();

  // both changes show, newest first, each by You with Undo
  const rows = changes.locator('[data-change]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Edited');
  await expect(rows.nth(0)).toContainText('Prefers tea → Prefers green tea');
  await expect(rows.nth(1)).toContainText('Added');
  await expect(rows.nth(1)).toContainText('+ Prefers tea');
  for (const i of [0, 1]) await expect(rows.nth(i).locator('.momo-chip').first()).toHaveText('You');
  await page.screenshot({ path: test.info().outputPath('memory-recent-changes.png') });

  // Undo the edit: the fact reads as before, the edit says Undone and offers no Undo, the undo is logged
  await rows.nth(0).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(facts.getByText('Prefers tea', { exact: true })).toBeVisible();
  await expect(facts.getByText('Prefers green tea', { exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Undid a change');
  const edit = changes.locator('[data-change]').filter({ hasText: 'Prefers tea → Prefers green tea' });
  await expect(edit.locator('.momo-chip').filter({ hasText: 'Undone' })).toBeVisible();
  await expect(edit.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);

  // edit it again, then try to undo the add: its fact changed since, so main refuses and nothing changes
  await fact.getByRole('button', { name: 'Edit', exact: true }).click();
  await fact.getByRole('textbox', { name: 'Fact', exact: true }).fill('Prefers oolong');
  await fact.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(facts.getByText('Prefers oolong', { exact: true })).toBeVisible();
  const add = changes.locator('[data-change]').filter({ hasText: '+ Prefers tea' });
  await add.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(add.getByRole('alert')).toHaveText("Couldn't undo: That fact changed since; undo the later change first");
  await expect(facts.getByText('Prefers oolong', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('memory-undo-refused.png') });

  // Settings shows the day's one background limit and each pass's share of it
  await goToMomoSettings(page, 'Brain');
  const background = settingsGroup(page, 'Background memory');
  await expect(background).toContainText('MoMo saves facts and search aliases in the background, within one daily limit.');
  await expect(background).toContainText(/of 200,000 tokens today\./);
  await expect(background).toContainText(/of 120,000 tokens today\. Up to 6,000 tokens a pass\./);
  await expect(background).toContainText(/of 100,000 tokens today\./);
  await background.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('settings-background-memory.png') });
});
