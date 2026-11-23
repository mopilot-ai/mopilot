import { archiveSidebarChat } from './fixtures/sidebar';
// Sidebar paging (Codex lists a hundred chats at a time) and the archive following Sage meta,
// in the real app against tests/e2e/fixtures/fake-codex.mjs.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

const sidebar = (page: Page) => page.getByRole('complementary');
const ids = (n: number) => Array.from({ length: n }, (_, i) => `019b0000-0000-7000-8000-${String(i).padStart(12, '0')}`);

test.describe('more chats than one page', () => {
  test.use({ harnesses: 'codex', seed: { codexThreads: ids(130).map((id, i) => ({ id, turns: [`paged chat ${i}`] })) } });

  test('Show more chats loads the next page of Codex chats', async ({ page, harness }) => {
    const pages = () =>
      harness
        .codexLog()
        .filter((l) => l.method === 'thread/list' && !l.params?.archived && !l.params?.searchTerm)
        .map((l) => l.params.cursor ?? null);
    await expect(sidebar(page).getByText('paged chat 0', { exact: true }).first()).toBeVisible();
    await expect.poll(pages).toEqual([null]);
    const more = sidebar(page).getByTestId('more-chats');
    await expect(more).toBeVisible();
    // dispatchEvent, not click(): scrolling the button into view loads the next page by itself and can detach it mid-click
    await more.dispatchEvent('click');
    await expect.poll(pages).toEqual([null, '100']);
    // the last page was the end: nothing more to load
    await expect(more).toHaveCount(0);
  });
});

test.describe('archiving a Codex chat', () => {
  const [KEEP, ARCH] = ids(2);
  test.use({
    harnesses: 'codex',
    seed: {
      codexThreads: [
        { id: KEEP, turns: ['chat to keep'] },
        { id: ARCH, turns: ['chat to archive'] },
      ],
    },
  });

  test('follows Sage meta: Codex is told, and the chat stays archived even where Codex still lists it', async ({ page, harness }) => {
    const userData = path.join(harness.dir, 'userData');
    const meta = () => JSON.parse(fs.readFileSync(path.join(userData, 'threads', `${ARCH}.v2`), 'utf8')).meta.archived;
    const row = sidebar(page).locator('.thread-row', { hasText: 'chat to archive' }).first();
    await expect(row).toBeVisible();
    await row.hover();
    await archiveSidebarChat(page, row);
    await expect(sidebar(page).locator('.thread-row', { hasText: 'chat to archive' })).toHaveCount(0);
    // Sage meta holds the archive; Codex is still told, best effort
    await expect.poll(meta).toEqual(expect.any(Number));
    await expect
      .poll(() =>
        harness
          .codexLog()
          .filter((l) => l.method === 'thread/archive')
          .map((l) => l.params.threadId),
      )
      .toEqual([ARCH]);

    // a restart where the (fake) Codex has forgotten the archive: Sage meta still keeps it out of the list
    await harness.relaunch();
    const p = harness.page;
    await expect(sidebar(p).locator('.thread-row', { hasText: 'chat to keep' }).first()).toBeVisible();
    await expect(sidebar(p).locator('.thread-row', { hasText: 'chat to archive' })).toHaveCount(0);
    await p.locator('.sidebar-title').first().click();
    await settingsEntry(p).click();
    await p.locator('.side-row', { hasText: 'Archived chats' }).click();
    const archived = p.locator('.settings-row', { hasText: 'chat to archive' });
    await expect(archived).toBeVisible();
    await archived.getByRole('button', { name: 'Unarchive' }).click();
    await expect.poll(meta).toBe(null);
    await p.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(sidebar(p).locator('.thread-row', { hasText: 'chat to archive' }).first()).toBeVisible();
  });
});
