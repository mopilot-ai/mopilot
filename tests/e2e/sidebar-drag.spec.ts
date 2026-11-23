// e2e-covers: src/components/sidebar/projectGroups.ts src/components/sidebar/Sidebar.tsx src/components/sidebar/ProjectGroup.tsx
// e2e-covers: src/store/projects.ts src/components/sidebar/homeTarget.ts
import { chooseSidebarChatAction } from './fixtures/sidebar';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const sessions = [
  { id: '11111111-1111-4111-8111-111111111111', cwd: 'work/alpha', title: 'Alpha first', turns: ['Alpha first'] },
  { id: '22222222-2222-4222-8222-222222222222', cwd: 'work/alpha', title: 'Alpha second', turns: ['Alpha second'] },
  { id: '33333333-3333-4333-8333-333333333333', cwd: 'work/beta', title: 'Beta chat', turns: ['Beta chat'] },
  { id: '44444444-4444-4444-8444-444444444444', cwd: 'work/folder', title: 'Folder first', turns: ['Folder first'] },
  { id: '55555555-5555-4555-8555-555555555555', cwd: 'work/folder', title: 'Folder second', turns: ['Folder second'] },
  { id: '66666666-6666-4666-8666-666666666666', cwd: '.', title: 'Recent first', turns: ['Recent first'] },
  { id: '77777777-7777-4777-8777-777777777777', cwd: '.', title: 'Recent second', turns: ['Recent second'] },
];

test.use({
  harnesses: 'claude',
  seed: {
    claudeSessions: sessions,
    files: ({ home, userData }) => {
      for (const folder of ['alpha', 'beta', 'folder']) fs.mkdirSync(path.join(home, 'work', folder), { recursive: true });
      fs.writeFileSync(
        path.join(userData, 'projects.json'),
        JSON.stringify({
          schemaVersion: 1,
          projects: ['alpha', 'beta'].map((name) => ({ id: name, name, path: path.join(home, 'work', name), source: 'sage' })),
        }),
      );
    },
  },
});

const group = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.project-group').filter({ has: page.locator('.project-row .side-row-label', { hasText: new RegExp(`^${name}$`) }) });

test('sidebar edge resizes, clamps, and remembers width after restart', async ({ page, harness }) => {
  const handle = page.getByRole('separator', { name: 'Resize sidebar' });
  await expect(handle).toBeVisible();
  await expect(page.locator('.thread-sidebar')).toHaveCSS('width', '288px');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.thread-sidebar')).toHaveCSS('width', '388px');
  await harness.relaunch();
  await expect(harness.page.locator('.thread-sidebar')).toHaveCSS('width', '388px');
  const p = harness.page;
  const drag = async (name: string, dx: number | ((x: number) => number)) => {
    const b = (await p.getByRole('separator', { name }).boundingBox())!;
    const x = b.x + b.width / 2;
    await p.mouse.move(x, b.y + 80);
    await p.mouse.down();
    await p.mouse.move(typeof dx === 'number' ? x + dx : dx(x), b.y + 80, { steps: 12 });
    await p.mouse.up();
  };
  // released between the hide point and the minimum width, it clamps to the minimum
  await drag('Resize sidebar', -238);
  await expect(p.locator('.thread-sidebar')).toHaveCSS('width', '200px');
  // released near the window edge, it hides; the edge stays draggable and opens it at the minimum again (#332)
  await drag('Resize sidebar', () => 10);
  const opener = p.getByRole('separator', { name: 'Drag to open sidebar' });
  await expect(opener).toBeVisible();
  await expect(p.getByRole('complementary')).toHaveCount(0);
  await drag('Drag to open sidebar', 150);
  await expect(p.getByRole('separator', { name: 'Resize sidebar' })).toBeVisible();
  await expect(p.locator('.thread-sidebar')).toHaveCSS('width', '200px');
});

test('projects and project chats drag with independent default ordering, and persist', async ({ page, harness }) => {
  await expect(group(page, 'alpha').locator('.thread-row')).toHaveCount(2);
  const projects = page.locator('.project-row .side-row-label');
  const names = await projects.allTextContents();
  await group(page, names[names.length - 1])
    .locator('.project-row')
    .dragTo(group(page, names[0]).locator('.project-row'), { targetPosition: { x: 40, y: 5 } });
  await expect(projects.first()).toHaveText(names[names.length - 1]);
  const rows = group(page, 'alpha').locator('.sidebar-chat-drag');
  const titles = await rows.locator('.thread-row .side-row-label').allTextContents();
  await rows.last().dragTo(rows.first(), { targetPosition: { x: 40, y: 5 } });
  await expect(rows.first()).toContainText(titles[1]);
  await rows.first().dragTo(rows.last(), { targetPosition: { x: 40, y: 25 } });
  await expect(rows.last()).toContainText(titles[1]);
  await harness.relaunch();
  await expect(harness.page.locator('.project-row .side-row-label').first()).toHaveText(names[names.length - 1]);
  await expect(group(harness.page, 'alpha').locator('.sidebar-chat-drag').last()).toContainText(titles[1]);
});

test('unsaved folder chats and Recents reorder without losing chats across groups', async ({ page }) => {
  const folderRows = group(page, 'folder').locator('.sidebar-chat-drag');
  await expect(folderRows).toHaveCount(2);
  const titles = await folderRows.locator('.side-row-label').allTextContents();
  await folderRows.last().dragTo(folderRows.first(), { targetPosition: { x: 40, y: 5 } });
  await expect(folderRows.first()).toContainText(titles[1]);
  const recents = page
    .locator('.sidebar-section')
    .filter({ has: page.getByRole('button', { name: 'Recents', exact: true }) })
    .locator('.sidebar-chat-drag');
  await page
    .locator('.sidebar-section')
    .filter({ has: page.getByRole('button', { name: 'Recents', exact: true }) })
    .getByRole('button', { name: 'Show 2 more in Recents', exact: true })
    .click();
  await expect(recents).toHaveCount(7);
  const recentTitles = await recents.locator('.side-row-label').allTextContents();
  await recents.last().dragTo(recents.first(), { targetPosition: { x: 40, y: 5 } });
  await expect(recents.first()).toContainText(recentTitles[recentTitles.length - 1]);
  await folderRows.first().dragTo(recents.first(), { targetPosition: { x: 40, y: 5 } });
  await expect(recents).toHaveCount(7);
  await expect(folderRows).toHaveCount(2);
});

test.describe('one list', () => {
  test.use({ seed: { claudeSessions: sessions.slice(0, 5), uiState: { prefs: { sidebarOrganize: 'list' } } } });
  test('chat dragging honors manual order in the flat list', async ({ page, harness }) => {
    const rows = page
      .locator('.sidebar-section')
      .filter({ has: page.getByRole('button', { name: 'Projects', exact: true }) })
      .locator('.sidebar-chat-drag');
    await expect(rows).toHaveCount(5);
    const titles = await rows.locator('.side-row-label').allTextContents();
    await rows.last().dragTo(rows.first(), { targetPosition: { x: 40, y: 5 } });
    await expect(rows.first()).toContainText(titles[4]);
    await harness.relaunch();
    await expect(
      harness.page
        .locator('.sidebar-section')
        .filter({ has: harness.page.getByRole('button', { name: 'Projects', exact: true }) })
        .locator('.sidebar-chat-drag')
        .first(),
    ).toContainText(titles[4]);
  });
});

test('pinned chats can be reordered independently and survive restart', async ({ page, harness }) => {
  const alpha = group(page, 'alpha').locator('.thread-row');
  await expect(alpha).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await alpha.nth(i).hover();
    await chooseSidebarChatAction(page, alpha.nth(i), 'Pin');
  }
  const pinned = page
    .locator('.sidebar-section')
    .filter({ has: page.locator('.side-label', { hasText: /^Pinned$/ }) })
    .locator('.sidebar-chat-drag');
  await expect(pinned).toHaveCount(2);
  const titles = await pinned.locator('.side-row-label').allTextContents();
  const projectTitles = await alpha.locator('.side-row-label').allTextContents();
  await pinned.last().dragTo(pinned.first(), { targetPosition: { x: 40, y: 5 } });
  await expect(pinned.first()).toContainText(titles[1]);
  await expect(alpha.locator('.side-row-label')).toHaveText(projectTitles);
  await harness.relaunch();
  const restored = harness.page
    .locator('.sidebar-section')
    .filter({ has: harness.page.locator('.side-label', { hasText: /^Pinned$/ }) })
    .locator('.sidebar-chat-drag');
  await expect(restored.first()).toContainText(titles[1]);
});
