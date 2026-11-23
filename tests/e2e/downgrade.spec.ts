// Downgrade: data migrated to v2 by this build still opens in the 0.2.0 release (commit 7a5bf12).
// Opt-in, it builds 0.2.0 from git (npm ci + vite build): npm run test:downgrade. See tests/downgrade.md.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { test, expect, NO_EXTERNAL } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

const { ChatsStore } = require('../../electron/platform/chats.cjs');

const sidebar = (page: Page) => page.getByRole('complementary');
const pinnedSection = (page: Page) =>
  sidebar(page).locator('.sidebar-section', { has: page.locator('.side-label', { hasText: /^Pinned$/ }) });

const CODEX_PINNED = '019a0000-0000-7000-8000-000000000001';
const CODEX_ARCHIVED = '019a0000-0000-7000-8000-000000000002';
const CODEX_SWITCHED = '019a0000-0000-7000-8000-000000000003';
const CODEX_ACP = '019a0000-0000-7000-8000-000000000004';
const CLAUDE_PINNED = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLAUDE_ARCHIVED = 'aaaaaaaa-0000-4000-8000-000000000002';
const CLAUDE_SWITCHED = 'aaaaaaaa-0000-4000-8000-000000000003';
const ACP_CHAT = 'acp:kimi:s9';
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

test.skip(!process.env.SAGE_DOWNGRADE, 'opt-in: SAGE_DOWNGRADE=1 (builds 0.2.0 from git, needs network the first time)');
test.setTimeout(10 * 60_000);

test.use({
  harnesses: 'both',
  seed: {
    // the profile as 0.2.0 left it; this build migrates it on first start
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
      { id: CODEX_ACP, turns: ['codex before acp'] },
    ],
    claudeSessions: [
      { id: CLAUDE_PINNED, cwd: 'work', turns: ['pinned claude chat'] },
      { id: CLAUDE_ARCHIVED, cwd: 'work', turns: ['archived claude chat'] },
      { id: CLAUDE_SWITCHED, cwd: 'work', turns: ['second on claude'] },
    ],
  },
});

test('0.2.0 opens data migrated by this build: chats, archive and pins are there, acp segments are not', async ({ harness }) => {
  const userData = path.join(harness.dir, 'userData');
  const threads = path.join(userData, 'threads');
  const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(userData, rel), 'utf8'));

  // 1. this build starts on the profile and migrates it
  await expect(pinnedSection(harness.page).getByText('pinned codex chat', { exact: true })).toBeVisible();
  await harness.quit();
  expect(json('migrations.json').some((e: any) => e.id === '2026-10-threads-v2' && e.result === 'ok')).toBe(true);

  // 2. this build adds acp work: a Codex chat that continued on Kimi, and a chat that began there
  const store = new ChatsStore(threads, { uiState: path.join(userData, 'ui-state.json') });
  store.setSegments(CODEX_ACP, [
    { harness: 'codex', nativeId: CODEX_ACP, start: 0, count: 1, model: null, handoff: null },
    { harness: 'acp:kimi', nativeId: 'acp:kimi:s1', start: 1, count: null, model: null, handoff: null },
  ]);
  store.patchMeta(CODEX_ACP, { pinned: true });
  store.patchMeta(ACP_CHAT, { pinned: true });
  const v2 = (id: string) => path.join(threads, `${encodeURIComponent(id)}.v2`);
  expect(fs.existsSync(v2(CODEX_ACP))).toBe(true);
  expect(fs.existsSync(v2(ACP_CHAT))).toBe(true);
  const before = Object.fromEntries(
    fs
      .readdirSync(threads)
      .filter((n) => n.endsWith('.v2'))
      .map((n) => [n, fs.readFileSync(path.join(threads, n), 'utf8')]),
  );

  // 3. the 0.2.0 build, built from git, on the same profile
  const dir020 = execFileSync(
    path.resolve(__dirname, '../downgrade/build-020.sh'),
    process.env.SAGE_DOWNGRADE_DIR ? [process.env.SAGE_DOWNGRADE_DIR] : [],
    { encoding: 'utf8', timeout: 8 * 60_000 },
  )
    .trim()
    .split('\n')
    .pop()!;
  const electronBin: string = createRequire(path.join(dir020, 'package.json'))('electron');
  const old = await electron.launch({
    executablePath: electronBin,
    args: ['--use-mock-keychain', '-r', NO_EXTERNAL, dir020],
    cwd: dir020,
    env: harness.env,
  });
  try {
    const page = await old.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    expect(await old.evaluate(({ app }) => app.getVersion())).toBe('0.2.0');

    // it starts and shows the pins of both harnesses
    await expect(pinnedSection(page).getByText('pinned codex chat', { exact: true })).toBeVisible();
    await expect(pinnedSection(page).getByText('pinned claude chat', { exact: true })).toBeVisible();
    // the switched chat shows once as its first segment (0.2.0 also lists the Claude session of the later
    // segment on its own); the archived Claude chat stays out of the list
    await expect(sidebar(page).getByText('first on codex', { exact: true })).toHaveCount(1);
    await expect(sidebar(page).getByText('archived claude chat')).toHaveCount(0);
    // the switched chat opens with both segments' history
    await sidebar(page).getByText('first on codex', { exact: true }).click();
    await expect(page.getByRole('main').getByText('fake-codex: first on codex', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('fake-claude: second on claude', { exact: true })).toBeVisible();
    // archived chats of both harnesses are listed
    await page.locator('.sidebar-title').first().click();
    await settingsEntry(page).click();
    await page.getByText('Archived chats', { exact: true }).first().click();
    await expect(page.getByText('archived codex chat', { exact: true })).toBeVisible();
    await expect(page.getByText('archived claude chat', { exact: true })).toBeVisible();

    // acp is unknown to it: nothing of the acp chats shows, and its own pin file never lists them
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(sidebar(page).getByText(/kimi/i)).toHaveCount(0);
    await expect(pinnedSection(page).getByText('codex before acp', { exact: true })).toHaveCount(0);
    const legacy = JSON.stringify(json('ui-state.json').pinned);
    expect(legacy).not.toContain('acp:');
    expect(legacy).not.toContain(CODEX_ACP);
    expect(errors).toEqual([]);
  } finally {
    await old.close().catch(() => {});
  }

  // 4. 0.2.0 doesn't touch the v2 files: coming back to this build loses nothing
  for (const [name, text] of Object.entries(before)) expect(fs.readFileSync(path.join(threads, name), 'utf8')).toBe(text);
  const after = new ChatsStore(threads, { uiState: path.join(userData, 'ui-state.json') });
  expect(after.get(ACP_CHAT).meta.pinned).toBe(true);
  expect(after.get(CODEX_ACP).segments.map((s: any) => s.harness)).toEqual(['codex', 'acp:kimi']);
});
