// Projects live in userData/projects.json: they work without Codex, and Codex's own projects are imported.
// e2e-covers: src/components/sidebar/projectGroups.ts src/components/sidebar/Sidebar.tsx src/components/sidebar/ProjectGroup.tsx
// e2e-covers: src/store/projects.ts src/components/sidebar/homeTarget.ts src/components/sidebar/SidebarNav.tsx
import { standaloneNewChat } from './fixtures/sidebar';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const group = (page: Page, name: string) =>
  sidebar(page)
    .locator('.project-group')
    .filter({ has: page.locator('.project-row', { hasText: name }) });
const projectsFile = (h: Harness) => path.join(h.dir, 'userData', 'projects.json');
/** The project row marked current: the home page's, where its new chat goes. */
const currentRow = (page: Page, name: string) => group(page, name).locator('.project-row.selected');
const savedProjects = (h: Harness) => {
  try {
    return JSON.parse(fs.readFileSync(projectsFile(h), 'utf8')).projects as any[];
  } catch {
    return [];
  }
};

/** Make a folder under HOME and have the native folder picker return it. */
async function pickFolder(h: Harness, rel: string) {
  const folder = path.join(h.dir, 'home', rel);
  fs.mkdirSync(folder, { recursive: true });
  await h.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, folder);
  return folder;
}

test.describe('Claude only', () => {
  test.use({ harnesses: 'claude' });

  test('add a project folder without Codex, and a Claude chat in it groups under it', async ({ page, harness }) => {
    await expect(composer(page)).toBeVisible();
    const folder = await pickFolder(harness, 'work/demo');
    await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
    await expect(group(page, 'demo')).toBeVisible();
    await expect.poll(() => savedProjects(harness)).toEqual([{ id: expect.any(String), name: 'demo', path: folder, source: 'sage' }]);
    await expect(page.getByText("Couldn't add project")).toHaveCount(0);

    await composer(page).fill('hello project');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main').getByText('fake-claude: hello project', { exact: true })).toBeVisible();
    // the chat ran in the project's folder and shows under it
    const cwds = harness
      .claudeLog()
      .flatMap((e) => (e.kind === 'argv' && e.argv.some((a) => a.startsWith('--session-id=')) ? [e.cwd] : []));
    expect(cwds).toEqual([folder]);
    await expect(group(page, 'demo').getByText('Fake chat title', { exact: true })).toBeVisible();
  });

  test("the top New chat starts outside any project; a project's own new chat starts in it", async ({ page, harness }) => {
    await expect(composer(page)).toBeVisible();
    const folder = await pickFolder(harness, 'work/demo');
    await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
    await expect(group(page, 'demo')).toBeVisible();
    const chatCwds = () =>
      harness.claudeLog().flatMap((e) => (e.kind === 'argv' && e.argv.some((a) => a.startsWith('--session-id=')) ? [e.cwd] : []));
    const sendAndWait = async (text: string) => {
      await composer(page).fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('main').getByText(`fake-claude: ${text}`, { exact: true })).toBeVisible();
    };

    await sendAndWait('in the project');
    expect(chatCwds()).toEqual([folder]);

    // the top New chat leaves the project, though the last chat was in it
    await standaloneNewChat(page).click();
    await expect(page.getByRole('main').getByText('fake-claude: in the project', { exact: true })).toHaveCount(0);
    await sendAndWait('outside');
    expect(chatCwds()).toHaveLength(2);
    expect(chatCwds()[1]).not.toBe(folder);

    // the project's own new chat goes back into it
    await group(page, 'demo').locator('.project-row').hover();
    await group(page, 'demo').getByRole('button', { name: 'New chat in demo' }).click();
    await expect(page.getByRole('main').getByText('fake-claude: outside', { exact: true })).toHaveCount(0);
    await sendAndWait('back in the project');
    expect(chatCwds()).toEqual([folder, expect.any(String), folder]);
  });
});

test.describe('Codex', () => {
  test.use({ harnesses: 'codex', codexProjects: ['work/imported'] });

  test("Codex's projects are imported, and a new one is still made in Codex", async ({ page, harness }) => {
    const imported = path.join(harness.dir, 'home', 'work', 'imported');
    await expect
      .poll(() => savedProjects(harness).map((p) => [p.name, p.path, p.source, !!p.codexId]))
      .toEqual([['imported', imported, 'codex', true]]);
    // imported with no chat: the home page's new chat goes to it, so the sidebar lists it as the current row (docs/project-sidebar.md)
    await expect(currentRow(page, 'imported')).toBeVisible();
    await expect(standaloneNewChat(page)).not.toHaveClass(/selected-soft/);
    // the activity view draws no project rows: there New chat is the home page's current entry, and back the row is
    const activity = sidebar(page).getByRole('button', { name: 'View activity', exact: true });
    await activity.click();
    await expect(standaloneNewChat(page)).toHaveClass(/selected-soft/);
    await activity.click();
    await expect(currentRow(page, 'imported')).toBeVisible();
    await expect(standaloneNewChat(page)).not.toHaveClass(/selected-soft/);
    expect(JSON.parse(fs.readFileSync(projectsFile(harness), 'utf8')).codexImportedAt).toEqual(expect.any(Number));

    // adding a folder still creates it in Codex too, and links the two
    const folder = await pickFolder(harness, 'work/added');
    await sidebar(page).getByRole('button', { name: 'Add new project' }).click();
    // listed while the new chat is written in it; the imported project, with no chat, is no longer the home page's
    await expect(group(page, 'added')).toBeVisible();
    await expect(sidebar(page).locator('.project-group > .project-row .side-row-label')).toHaveText(['added']);
    await expect
      .poll(() =>
        harness
          .codexLog()
          .filter((e) => e.method === 'project/create')
          .map((e) => e.params.roots[0].path),
      )
      .toEqual([folder]);
    await expect
      .poll(() => savedProjects(harness).map((p) => [p.name, !!p.codexId]))
      .toEqual([
        ['added', true],
        ['imported', true],
      ]);
    expect(new Set(savedProjects(harness).map((p) => p.codexId)).size).toBe(2);
  });
});

test.describe('Claude Code as the default, Codex installed', () => {
  test.use({ harnesses: 'both', codexProjects: ['work/imported'], seed: { uiState: { prefs: { harness: 'claude' } } } });

  test("Codex's projects are imported by a short-lived app-server, and the app's own Codex stays down", async ({ page, harness }) => {
    const imported = path.join(harness.dir, 'home', 'work', 'imported');
    await expect
      .poll(() => savedProjects(harness).map((p) => [p.name, p.path, p.source, !!p.codexId]))
      .toEqual([['imported', imported, 'codex', true]]);
    await expect(currentRow(page, 'imported')).toBeVisible();
    // one app-server started, it asked for the projects and nothing else (fake/start is the fake's own log line)
    const methods = harness
      .codexLog()
      .map((e: any) => e.method)
      .filter(Boolean);
    expect(methods.filter((m: string) => m === 'fake/start')).toHaveLength(1);
    expect(methods.filter((m: string) => m !== 'fake/start')).toEqual(['initialize', 'initialized', 'project/list']);
  });
});

test.describe('a failed import', () => {
  test.use({
    harnesses: 'both',
    codexProjects: ['work/imported'],
    seed: { uiState: { prefs: { harness: 'claude' } } },
    env: { FAKE_CODEX_PROJECTS_FAIL: '1' },
  });

  test('is recorded in projects.json, and tried again at the next launch', async ({ page, harness }) => {
    await expect(composer(page)).toBeVisible();
    const failure = () => {
      try {
        return JSON.parse(fs.readFileSync(projectsFile(harness), 'utf8')).codexImportFailure;
      } catch {
        return null;
      }
    };
    await expect.poll(failure).toMatchObject({ message: expect.stringContaining('project/list is not available'), attempts: 1 });
    expect(savedProjects(harness)).toEqual([]);
    await harness.relaunch();
    await expect.poll(() => failure()?.attempts).toBe(2);
  });
});
