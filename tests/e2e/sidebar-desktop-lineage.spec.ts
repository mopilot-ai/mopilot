// Claude desktop side sessions (#4438): a chat a Claude desktop chat started nests under it in the sidebar, read from
// Claude desktop's session files under the temp HOME; a session detached there stays top-level, and nothing here offers
// MoPilot's family actions (detach, archive all) for those links.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const PARENT = '4b1e0000-0000-4000-8000-000000000001';
const CHILD = '4b1e0000-0000-4000-8000-000000000002';
const GRAND = '4b1e0000-0000-4000-8000-000000000003';
const DETACHED = '4b1e0000-0000-4000-8000-000000000004';

const sessions = [
  { sessionId: 'local_parent', cliSessionId: PARENT, createdAt: 1 },
  { sessionId: 'local_child', cliSessionId: CHILD, createdAt: 2, spawnedFrom: { sessionId: 'local_parent', sideSession: true } },
  { sessionId: 'local_grand', cliSessionId: GRAND, createdAt: 3, spawnedFrom: { sessionId: 'local_child', sideSession: true } },
  { sessionId: 'local_detached', cliSessionId: DETACHED, createdAt: 4, spawnedFrom: { sessionId: 'local_parent' }, lineageDetached: true },
];

test.use({
  harnesses: 'claude',
  seed: {
    claudeSessions: [
      { id: PARENT, cwd: 'project', title: 'Desktop parent', turns: ['plan the work'] },
      { id: CHILD, cwd: 'project', title: 'Desktop worker', turns: ['do part one'] },
      { id: GRAND, cwd: 'project', title: 'Desktop grandchild', turns: ['do part two'] },
      { id: DETACHED, cwd: 'project', title: 'Desktop detached', turns: ['went its own way'] },
    ],
    files: ({ home }) => {
      // Claude desktop's data folder as the app sees it (electron/platform/nativeSchedulers.cjs claudeAppData): the app
      // gets no XDG_CONFIG_HOME (fixtures/app.ts), so on Linux it is HOME/.config even where the runner sets one, and on
      // Windows APPDATA, which fixtures/app.ts puts at HOME/AppData/Roaming
      const appData =
        process.platform === 'darwin'
          ? path.join(home, 'Library', 'Application Support', 'Claude')
          : process.platform === 'win32'
            ? path.join(home, 'AppData', 'Roaming', 'Claude')
            : path.join(home, '.config', 'Claude');
      const dir = path.join(appData, 'claude-code-sessions', 'account', 'org');
      fs.mkdirSync(dir, { recursive: true });
      for (const s of sessions) fs.writeFileSync(path.join(dir, `${s.sessionId}.json`), JSON.stringify(s));
    },
  },
});

test('Claude desktop side sessions nest under their parent; a detached one stays top-level', async ({ page }, testInfo) => {
  const sidebar = page.getByRole('complementary');
  // the chats show under their project and in Recents: check the Recents list, as sidebar-family-parity.spec.ts does
  const recents = sidebar.locator('.sidebar-section').filter({ has: page.getByRole('button', { name: 'Recents', exact: true }) });
  const row = (id: string) => recents.locator(`[data-sidebar-chat="claude:${id}"]`);
  await expect(row(PARENT)).toBeVisible();
  const family = recents.locator('.side-children');
  await expect(family).toHaveCount(1);
  await expect(family.locator('.thread-row')).toHaveCount(2);
  await expect(row(CHILD)).toHaveClass(/linked-child/);
  await expect(row(GRAND)).toHaveClass(/linked-child/);
  await expect(row(DETACHED)).not.toHaveClass(/linked-child/);
  await expect(row(PARENT).locator('.nested-caret')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-lineage-nested.png') });

  // folding works as for MoPilot's own families
  await row(PARENT).hover();
  await row(PARENT).getByRole('button', { name: 'Hide nested sessions' }).click();
  await expect(family.locator('.thread-row')).toHaveCount(0);
  await expect(family.locator('.nested-summary')).toContainText('2 nested sessions');
  await family.locator('.nested-summary').click();
  await expect(family.locator('.thread-row')).toHaveCount(2);

  // the link is Claude desktop's: MoPilot offers no detach for it
  await row(CHILD).click();
  await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  // Utilities holds Detach only for a link MoPilot's journal owns; with no session file to reveal it is not offered at all
  await expect(page.getByRole('menuitem', { name: 'Utilities', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Detach to top level', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
});
