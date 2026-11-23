// e2e-covers: src/components/sidebar/projectGroups.ts src/components/sidebar/Sidebar.tsx src/components/sidebar/ProjectGroup.tsx
// e2e-covers: src/store/projects.ts src/components/sidebar/homeTarget.ts
import { archiveSidebarChat } from './fixtures/sidebar';
import { settingsEntry } from './fixtures/settings';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const sidebar = (p: Page) => p.getByRole('complementary');
const group = (p: Page, name: string) =>
  sidebar(p)
    .locator('.project-group')
    .filter({ has: p.locator('.project-row .side-row-label', { hasText: new RegExp(`^${name}$`) }) });
const projectNames = (p: Page) => sidebar(p).locator('.project-group > .project-row .side-row-label');
const chatNames = (p: Page, name: string) => group(p, name).locator('.thread-row .side-row-label');
async function archive(p: Page, project: string, title: string) {
  const row = group(p, project).locator('.thread-row', { hasText: title });
  await row.hover();
  await archiveSidebarChat(p, row);
  await expect(row).toHaveCount(0);
}
async function openArchived(p: Page) {
  await p.locator('.sidebar-title').first().click();
  await settingsEntry(p).click();
  await p.locator('.side-row', { hasText: 'Archived chats' }).click();
}
async function orderMenu(p: Page, label: string, choice: string) {
  await sidebar(p).getByRole('button', { name: 'Project sidebar options' }).click();
  await p.locator('.menu-item', { hasText: label }).hover();
  await p
    .locator('.menu-item')
    .filter({ has: p.locator('.menu-label', { hasText: new RegExp(`^${choice}$`) }) })
    .click();
  await p.keyboard.press('Escape');
}

test.describe('saved projects', () => {
  test.use({
    harnesses: 'codex',
    seed: {
      codexThreads: [
        { id: '019b0000-0000-7000-8000-000000000001', cwd: 'work/taiwan', name: 'Latest itinerary', turns: ['latest'] },
        { id: '019b0000-0000-7000-8000-000000000002', cwd: 'work/alpha', name: 'Alpha chat', turns: ['alpha'] },
        { id: '019b0000-0000-7000-8000-000000000003', cwd: 'work/taiwan', name: 'Older itinerary', turns: ['older'] },
      ],
      files: ({ home, userData }) => {
        for (const name of ['taiwan', 'alpha']) fs.mkdirSync(path.join(home, 'work', name), { recursive: true });
        fs.writeFileSync(
          path.join(userData, 'projects.json'),
          JSON.stringify({ projects: ['taiwan', 'alpha'].map((name) => ({ id: name, name, path: path.join(home, 'work', name) })) }),
        );
      },
    },
  });

  test('archive and Undo preserve project position and chat recency; the last archive drops the project until a chat returns', async ({
    page,
    harness,
  }) => {
    await orderMenu(page, 'Project order', 'Custom');
    await expect(chatNames(page, 'taiwan')).toHaveText(['Latest itinerary', 'Older itinerary']);
    await expect(projectNames(page)).toHaveText(['taiwan', 'alpha']);
    await archive(page, 'taiwan', 'Latest itinerary');
    await expect(projectNames(page)).toHaveText(['taiwan', 'alpha']);
    await expect(chatNames(page, 'taiwan')).toHaveText(['Older itinerary']);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(chatNames(page, 'taiwan')).toHaveText(['Latest itinerary', 'Older itinerary']);
    await archive(page, 'taiwan', 'Latest itinerary');
    await archive(page, 'taiwan', 'Older itinerary');
    // no active chat left: the project leaves the sidebar, as a folder does in Claude Code's
    await expect(group(page, 'taiwan')).toHaveCount(0);
    await expect(projectNames(page)).toHaveText(['alpha']);
    await page.screenshot({ path: test.info().outputPath('last-chat-archived.png') });
    await harness.relaunch();
    const p = harness.page;
    await expect(projectNames(p)).toHaveText(['alpha']);
    // restoring a chat returns the project to its Custom place
    await openArchived(p);
    const row = p.locator('.settings-row', { hasText: 'Older itinerary' });
    await row.getByRole('button', { name: 'Unarchive' }).click();
    await expect(row).toHaveCount(0);
    await p.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(projectNames(p)).toHaveText(['taiwan', 'alpha']);
    await expect(chatNames(p, 'taiwan')).toHaveText(['Older itinerary']);
  });

  test('project sorting is independent of chat sorting; dragging switches to persistent Custom order', async ({ page, harness }) => {
    await expect(chatNames(page, 'taiwan')).toHaveText(['Latest itinerary', 'Older itinerary']);
    await orderMenu(page, 'Project order', 'Name');
    await expect(projectNames(page)).toHaveText(['alpha', 'taiwan']);
    await expect(chatNames(page, 'taiwan')).toHaveText(['Latest itinerary', 'Older itinerary']);
    await group(page, 'taiwan')
      .locator('.project-row')
      .dragTo(group(page, 'alpha').locator('.project-row'), { targetPosition: { x: 40, y: 5 } });
    await expect(projectNames(page)).toHaveText(['taiwan', 'alpha']);
    await expect(page.getByText('Project order set to Custom')).toBeVisible();
    await page.keyboard.press('Escape');
    await sidebar(page).getByRole('button', { name: 'Projects', exact: true }).hover();
    await archive(page, 'taiwan', 'Latest itinerary');
    await expect(projectNames(page)).toHaveText(['taiwan', 'alpha']);
    await harness.relaunch();
    await expect(projectNames(harness.page)).toHaveText(['taiwan', 'alpha']);
    await expect(chatNames(harness.page, 'taiwan')).toHaveText(['Older itinerary']);
  });

  test('pinning keeps projects above Custom order and archiving preserves another collapsed project', async ({ page, harness }) => {
    // Recent activity is the default project order (53c07999); this checks pinning against Custom order
    await orderMenu(page, 'Project order', 'Custom');
    await expect(projectNames(page)).toHaveText(['taiwan', 'alpha']);
    await group(page, 'alpha').locator('.project-row').click({ button: 'right' });
    await page.getByText('Pin', { exact: true }).click();
    await expect(projectNames(page)).toHaveText(['alpha', 'taiwan']);
    await group(page, 'alpha').locator('.project-row').click();
    await expect(chatNames(page, 'alpha')).toHaveCount(0);
    await archive(page, 'taiwan', 'Latest itinerary');
    await expect(projectNames(page)).toHaveText(['alpha', 'taiwan']);
    await expect(chatNames(page, 'alpha')).toHaveCount(0);
    await harness.relaunch();
    const p = harness.page;
    await expect(projectNames(p)).toHaveText(['alpha', 'taiwan']);
    await expect(chatNames(p, 'alpha')).toHaveCount(0);
    await group(p, 'alpha').locator('.project-row').click({ button: 'right' });
    await p.getByText('Unpin', { exact: true }).click();
    await expect(projectNames(p)).toHaveText(['taiwan', 'alpha']);
  });

  test('Recent activity is the default and Recents opens the chat in its collapsed project', async ({ page }) => {
    await expect(chatNames(page, 'taiwan')).toHaveText(['Latest itinerary', 'Older itinerary']);
    await archive(page, 'taiwan', 'Latest itinerary');
    await expect(projectNames(page)).toHaveText(['alpha', 'taiwan']);
    await group(page, 'taiwan').locator('.project-row').click();
    await expect(chatNames(page, 'taiwan')).toHaveCount(0);
    const recents = sidebar(page)
      .locator('.sidebar-section')
      .filter({ has: page.locator('.side-label', { hasText: /^Recents$/ }) });
    await recents.locator('.thread-row', { hasText: 'Older itinerary' }).click();
    await expect(chatNames(page, 'taiwan')).toHaveText(['Older itinerary']);
    await expect(group(page, 'taiwan').locator('.thread-row.selected')).toHaveCount(1);
  });
});

test.describe('discovered Claude folder', () => {
  test.use({
    harnesses: 'claude',
    seed: {
      claudeSessions: [
        { id: '11111111-1111-4111-8111-111111111111', cwd: 'work/taiwan', title: 'Taiwan itinerary', turns: ['plan a trip'] },
      ],
    },
  });

  test('last-chat archive drops the inferred folder, after restart too; restore returns to it', async ({ page, harness }) => {
    await expect(chatNames(page, 'taiwan')).toHaveText(['Taiwan itinerary']);
    await archive(page, 'taiwan', 'Taiwan itinerary');
    await expect(group(page, 'taiwan')).toHaveCount(0);
    await harness.relaunch();
    const p = harness.page;
    await expect(group(p, 'taiwan')).toHaveCount(0);
    await openArchived(p);
    const row = p.locator('.settings-row', { hasText: 'Taiwan itinerary' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Unarchive' }).click();
    await p.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(chatNames(p, 'taiwan')).toHaveText(['Taiwan itinerary']);
    await expect(projectNames(p)).toHaveText(['taiwan']);
  });
  test('Remove from sidebar hides a remembered folder without deleting its chat', async ({ page, harness }) => {
    await expect(chatNames(page, 'taiwan')).toHaveText(['Taiwan itinerary']);
    page.on('dialog', (dialog) => dialog.accept());
    await group(page, 'taiwan').locator('.project-row').click({ button: 'right' });
    await page.getByText('Remove from sidebar', { exact: true }).click();
    await expect(group(page, 'taiwan')).toHaveCount(0);
    await expect(sidebar(page).locator('.thread-row', { hasText: 'Taiwan itinerary' })).toHaveCount(1);
    await harness.relaunch();
    await expect(group(harness.page, 'taiwan')).toHaveCount(0);
    await expect(sidebar(harness.page).locator('.thread-row', { hasText: 'Taiwan itinerary' })).toHaveCount(1);
  });
});

test.describe('pinned folder aliases', () => {
  test.use({
    harnesses: 'codex',
    seed: {
      uiState: { prefs: { pinnedProjects: ['new'], sidebarProjectOrder: ['busy', 'old', 'new'] } },
      codexThreads: [
        { id: '019b0000-0000-7000-8000-000000000011', cwd: 'work/busy', name: 'Busy chat', turns: ['busy'] },
        { id: '019b0000-0000-7000-8000-000000000012', cwd: 'work/real', name: 'Alias chat', turns: ['alias'] },
      ],
      files: ({ home, userData }) => {
        const real = path.join(home, 'work/real');
        const alias = path.join(home, 'work/linked');
        const busy = path.join(home, 'work/busy');
        fs.mkdirSync(real, { recursive: true });
        fs.mkdirSync(busy, { recursive: true });
        fs.symlinkSync(real, alias, 'junction');
        fs.writeFileSync(
          path.join(userData, 'projects.json'),
          JSON.stringify({
            projects: [
              { id: 'busy', name: 'Busy', path: busy },
              { id: 'old', name: 'Sage', path: alias },
              { id: 'new', name: 'Sage', path: real },
            ],
          }),
        );
      },
    },
  });

  test('a pin on a saved alias survives archive and restart, then Unpin removes the empty group', async ({ page, harness }) => {
    await expect(projectNames(page)).toHaveText(['Sage', 'Busy']);
    await archive(page, 'Sage', 'Alias chat');
    await expect(group(page, 'Sage').getByText('No active chats', { exact: true })).toBeVisible();
    await harness.relaunch();
    const p = harness.page;
    await expect(projectNames(p)).toHaveText(['Sage', 'Busy']);
    await group(p, 'Sage').locator('.project-row').click({ button: 'right' });
    await p.getByText('Unpin', { exact: true }).click();
    await expect(group(p, 'Sage')).toHaveCount(0);
    await expect(projectNames(p)).toHaveText(['Busy']);
  });
});
