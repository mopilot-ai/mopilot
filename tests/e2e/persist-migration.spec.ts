import { chooseSidebarChatAction } from './fixtures/sidebar';
// Upgrading from 0.2.0: chat state in ui-state.json and threads/<id>.json moves to per-chat
// threads/<id>.v2 files before any window opens, and the app shows the same pins, archive
// and switched chat. Changes made afterwards are mirrored back to where 0.2.0 reads them.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

const sidebar = (page: Page) => page.getByRole('complementary');
const transcript = (page: Page) => page.getByRole('main');
const pinnedSection = (page: Page) =>
  sidebar(page).locator('.sidebar-section', { has: page.locator('.side-label', { hasText: /^Pinned$/ }) });

const CODEX_PINNED = '019a0000-0000-7000-8000-000000000001';
const CODEX_ARCHIVED = '019a0000-0000-7000-8000-000000000002';
const CODEX_SWITCHED = '019a0000-0000-7000-8000-000000000003';
const CLAUDE_PINNED = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLAUDE_ARCHIVED = 'aaaaaaaa-0000-4000-8000-000000000002';
const CLAUDE_SWITCHED = 'aaaaaaaa-0000-4000-8000-000000000003';
const switchedSegments = [
  { harness: 'codex', nativeId: CODEX_SWITCHED, start: 0, count: 1, model: null, handoff: null },
  {
    harness: 'claude',
    nativeId: `claude:${CLAUDE_SWITCHED}`,
    start: 1,
    count: null,
    model: 'sonnet',
    handoff: { mode: 'auto', tokens: 20, text: 'handoff' },
  },
];

test.use({
  harnesses: 'both',
  seed: {
    uiState: {
      pinned: { [CODEX_PINNED]: true, [`claude:${CLAUDE_PINNED}`]: true },
      unread: {},
      claudeArchived: { [`claude:${CLAUDE_ARCHIVED}`]: 1760000000000 },
      claudeChats: {},
      worktreeOf: {},
    },
    threads: { [`${CODEX_SWITCHED}.json`]: { id: CODEX_SWITCHED, segments: switchedSegments } },
    codexThreads: [
      { id: CODEX_PINNED, turns: ['pinned codex chat'] },
      { id: CODEX_ARCHIVED, turns: ['archived codex chat'], archived: true },
      { id: CODEX_SWITCHED, turns: ['first on codex'] },
    ],
    claudeSessions: [
      { id: CLAUDE_PINNED, cwd: 'work', turns: ['pinned claude chat'] },
      { id: CLAUDE_ARCHIVED, cwd: 'work', turns: ['archived claude chat'] },
      { id: CLAUDE_SWITCHED, cwd: 'work', turns: ['second on claude'] },
    ],
  },
});

test('upgrade from 0.2.0: pins, archive and a switched chat survive the move to v2 files', async ({ page, harness }) => {
  const userData = path.join(harness.dir, 'userData');
  const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(userData, rel), 'utf8'));

  // pinned Codex and Claude chats sit under Pinned
  await expect(pinnedSection(page).getByText('pinned codex chat', { exact: true })).toBeVisible();
  await expect(pinnedSection(page).getByText('pinned claude chat', { exact: true })).toBeVisible();
  // the archived Claude chat stays out of the sidebar; the switched chat shows once, as its first segment
  await expect(sidebar(page).getByText('first on codex', { exact: true })).toHaveCount(1);
  await expect(sidebar(page).getByText('archived claude chat')).toHaveCount(0);
  await expect(sidebar(page).getByText('second on claude')).toHaveCount(0);

  // the migration ran before the window opened, with a backup and matching counts
  // the chat-data migration; the cookie migration (nothing to carry over in this profile) records itself too
  const runs = json('migrations.json').filter((e: any) => !String(e.id).startsWith('cookies-'));
  expect(runs.map((e: any) => [e.id, e.result])).toEqual([['2026-10-threads-v2', 'ok']]);
  expect(
    json('migrations.json')
      .filter((e: any) => e.id === 'cookies-v1')
      .map((e: any) => e.result),
    // a Windows profile never had the pre-rebrand app's cookies, so it is not run there (electron/app/lifecycle.cjs)
  ).toEqual(process.platform === 'win32' ? [] : ['none']);
  expect(fs.readdirSync(path.join(userData, 'backups')).filter((n) => n.startsWith('pre-v2-'))).toHaveLength(1);
  const report = json(path.relative(userData, runs[0].report));
  expect(report.before).toEqual(report.after);
  expect(report.before).toMatchObject({ chats: 4, pinned: 2, archived: 1, multiSegment: 1 });
  expect(json(`threads/${encodeURIComponent(`claude:${CLAUDE_PINNED}`)}.v2`).meta.pinned).toBe(true);
  expect(json(`threads/${CODEX_SWITCHED}.v2`).segments.map((s: any) => s.kind)).toEqual(['codex', 'claude']);

  // the switched chat opens with both segments' history
  await sidebar(page).getByText('first on codex', { exact: true }).click();
  await expect(transcript(page).getByText('fake-codex: first on codex', { exact: true })).toBeVisible();
  await expect(transcript(page).getByText('fake-claude: second on claude', { exact: true })).toBeVisible();

  // pinning it writes its v2 file and mirrors the old key for 0.2.0
  const switchedRow = sidebar(page).locator('.thread-row', { hasText: 'first on codex' });
  await switchedRow.hover();
  await chooseSidebarChatAction(page, switchedRow, 'Pin');
  await expect(pinnedSection(page).getByText('first on codex', { exact: true })).toBeVisible();
  await expect.poll(() => json(`threads/${CODEX_SWITCHED}.v2`).meta.pinned).toBe(true);
  await expect
    .poll(() => json('ui-state.json').pinned)
    .toEqual({ [CODEX_PINNED]: true, [`claude:${CLAUDE_PINNED}`]: true, [CODEX_SWITCHED]: true });
  expect(json(`threads/${CODEX_SWITCHED}.json`).segments).toEqual(switchedSegments);

  // archived chats of both harnesses are listed; unarchiving the Claude one brings it back
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.getByText('Archived chats', { exact: true }).first().click();
  const archivedRow = (t: string) => page.locator('.settings-row', { hasText: t });
  await expect(page.getByText('archived codex chat', { exact: true })).toBeVisible();
  await expect(page.getByText('archived claude chat', { exact: true })).toBeVisible();
  await archivedRow('archived claude chat').getByRole('button', { name: 'Unarchive' }).click();
  await expect.poll(() => json('ui-state.json').claudeArchived).toEqual({});
  await expect.poll(() => json(`threads/${encodeURIComponent(`claude:${CLAUDE_ARCHIVED}`)}.v2`).meta.archived).toBe(null);
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  // it is listed under its folder and again in Recents
  await expect(sidebar(page).getByText('archived claude chat', { exact: true }).first()).toBeVisible();
});

const openMigrationReport = async (page: Page) => {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  // Settings → About → Diagnostics → Chat data
  await page.locator('.settings-nav .side-row', { hasText: /^About$/ }).click();
  await page.getByRole('button', { name: /^Chat data/ }).click();
  await expect(page.getByTestId('migration-report')).toBeVisible();
};

test('Settings → About → Chat data shows the migration report: counts match and nothing failed', async ({ page }) => {
  await expect(sidebar(page).getByTestId('migration-banner')).toHaveCount(0);
  await openMigrationReport(page);
  await expect(page.getByTestId('migration-result')).toContainText('Finished');
  const row = (k: string) => page.getByTestId('migration-counts').locator(`tr[data-count="${k}"] td`);
  await expect(row('chats')).toHaveText(['4', '4']);
  await expect(row('pinned')).toHaveText(['2', '2']);
  await expect(row('multiSegment')).toHaveText(['1', '1']);
  await expect(page.getByTestId('migration-failed')).toHaveCount(0);
  // nothing to retry; the backup can be restored
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore pre-migration data' })).toBeEnabled();
});

test.describe('a migration that fails', () => {
  // a chat file written by a newer build can't be moved, so its pin is never counted as migrated
  test.use({
    seed: {
      uiState: { pinned: { [CODEX_PINNED]: true }, unread: {}, claudeArchived: {}, claudeChats: {}, worktreeOf: {} },
      threads: { [`${CODEX_PINNED}.v2`]: { schemaVersion: 3, id: CODEX_PINNED, segments: [], meta: {} } },
      codexThreads: [{ id: CODEX_PINNED, turns: ['pinned codex chat'] }],
    },
  });

  test('the sidebar banner offers Retry, the report lists the counts, and the backup restores', async ({ page, harness }) => {
    const userData = path.join(harness.dir, 'userData');
    const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(userData, rel), 'utf8'));
    const banner = sidebar(page).getByTestId('migration-banner');
    await expect(banner).toContainText("Couldn't move archived chats");
    // the old files keep serving the chat meanwhile
    await expect(pinnedSection(page).getByText('pinned codex chat', { exact: true })).toBeVisible();
    expect(json('migrations.json').find((e: any) => e.id === '2026-10-threads-v2').result).toBe('failed');

    // Report opens Settings → About with Chat data expanded
    await banner.getByRole('button', { name: 'Report' }).click();
    await expect(page.getByTestId('migration-report')).toBeVisible();
    await expect(page.getByTestId('migration-result')).toContainText('Failed');
    await expect(page.getByTestId('migration-counts').locator('tr[data-count="pinned"] td')).toHaveText(['1', '0']);

    await page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Restore pre-migration data' }).click();
    await expect(page.getByTestId('migration-result')).toContainText('Restored');
    await expect(page.getByTestId('migration-banner')).toHaveCount(0);
    expect(json('migrations.json').pop().result).toBe('restored');
    expect(json('ui-state.json').pinned).toEqual({ [CODEX_PINNED]: true });
  });
});
