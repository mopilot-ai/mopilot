// The session rail behaves as Claude Desktop's on every harness, in the real app: sections start as Desktop's (Context and
// Connectors collapsed), a fold by hand is how new chats start, the header's menu hides a section and resets the layout, and a
// section moves by the menu or by dragging its header; on Codex a running background command has its own section.
// e2e-covers: src/components/panels/RailSection.tsx src/store/railSections.ts src/components/panels/SummaryPanel.tsx src/components/panels/SummaryBackgroundTasks.tsx
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

// a basic harness is admitted only with sage-mcp, which builds only on macOS
test.skip(process.platform !== 'darwin', 'the ACP case needs a Mac');

const sectionIds = (page: Page) =>
  page.locator('.summary-panel [data-rail-section]').evaluateAll((els) => els.map((el) => el.getAttribute('data-rail-section')));
const section = (page: Page, id: string) => page.locator(`.summary-panel [data-rail-section="${id}"]`);
const header = (page: Page, id: string) => section(page, id).locator(':scope > summary');
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });
// the Show list's sections are checkboxes in the menu
const showItem = (page: Page, name: string) => page.getByRole('menuitemcheckbox', { name, exact: true });

for (const family of [
  { label: 'Codex', harnesses: 'codex', reply: 'fake-codex', acp: {} },
  { label: 'Claude Code', harnesses: 'claude', reply: 'fake-claude', acp: {} },
  { label: 'ACP', harnesses: 'none', reply: 'fake-acp', acp: { kimi: { resume: true } } },
] as const) {
  test.describe(`the session rail on ${family.label}`, () => {
    test.use({ harnesses: family.harnesses, acp: family.acp, seed: { uiState: { summaryOpen: true } } });

    test('starts as Claude Desktop’s, keeps a fold by hand, hides, resets and reorders its sections', async ({ page }) => {
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      await composer.fill('hello rail');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('main').getByText(`${family.reply}: hello rail`, { exact: true })).toBeVisible();

      // Environment first and open; Context collapsed, its summary readable
      await expect(section(page, 'environment')).toHaveAttribute('open', '');
      await expect(section(page, 'context')).not.toHaveAttribute('open', '');
      const first = await sectionIds(page);
      expect(first[0]).toBe('environment');
      expect(first).toContain('sources');

      // a fold by hand is this chat's and how new chats start, as Claude Desktop's
      await header(page, 'sources').click();
      await expect(section(page, 'sources')).not.toHaveAttribute('open', '');
      await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      await composer.fill('a second chat');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('main').getByText(`${family.reply}: a second chat`, { exact: true })).toBeVisible();
      await expect(section(page, 'sources')).not.toHaveAttribute('open', '');
      await header(page, 'sources').click();
      await expect(section(page, 'sources')).toHaveAttribute('open', '');

      // the header's menu hides a section (Environment is not offered) and resets the layout
      await header(page, 'sources').click({ button: 'right' });
      await expect(showItem(page, 'Context')).toBeVisible();
      await expect(showItem(page, 'Environment')).toHaveCount(0);
      await showItem(page, 'Sources').click();
      await expect(section(page, 'sources')).toHaveCount(0);
      await header(page, 'environment').click({ button: 'right' });
      await menuItem(page, 'Reset to defaults').click();
      await expect(section(page, 'sources')).toHaveCount(1);

      // a section moves up by the menu, and by dragging its header onto another
      await header(page, 'context').click({ button: 'right' });
      await menuItem(page, 'Move up').click();
      await expect.poll(async () => (await sectionIds(page)).indexOf('context')).toBe(first.indexOf('context') - 1);
      await header(page, 'sources').dragTo(header(page, 'environment'), { targetPosition: { x: 10, y: 2 } });
      // dropped on Environment's upper half, Sources takes the place just above it
      await expect
        .poll(async () => {
          const ids = await sectionIds(page);
          return ids.indexOf('environment') - ids.indexOf('sources');
        })
        .toBe(1);
      await header(page, 'sources').click({ button: 'right' });
      await menuItem(page, 'Reset to defaults').click();
      await expect.poll(async () => (await sectionIds(page))[0]).toBe('environment');
    });
  });
}

test.describe('the session rail on Codex while a background command runs', () => {
  test.use({ harnesses: 'codex', seed: { uiState: { summaryOpen: true } } });

  test('Background tasks lists the running command with Stop, as Claude Desktop’s', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await composer.fill('start the server BGTERM 25s');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const tasks = section(page, 'backgroundTasks');
    await expect(tasks.locator('.summary-task').first()).toBeVisible();
    await expect(tasks.getByRole('button', { name: /^Stop / }).first()).toBeVisible();
    await expect(tasks.locator(':scope > summary .rail-section-summary')).toHaveText('1 running');
  });
});
