// A chat's PR inbox (designs/session-prs-compact): a chat that started two sessions, each with a PR whose checks fail,
// lists both in its PR rail and asks nothing itself: only the session asking a question needs the user, with its
// question whole, its answers and Open session; the one stuck on failing checks is on its way. An answer goes to its
// session from the tray, and the session chip and Open session open the session.
// The asking session's sidebar row counts its question, its parent's summary panel lists the same PRs, the tray's All chats
// lists the chat's section, and Settings has the switch for the notification that one needs you.
// Covers 'src/components/thread/PrInbox.tsx' and 'src/lib/prInbox.ts'.
// e2e-covers: src/components/sidebar/SidebarInboxCount.tsx src/session/chatRowState.ts src/components/sidebar/ChildRows.tsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { openSettingsSection, settingsEntry } from './fixtures/settings';
import { withPath } from './fixtures/nodeCommand';

const ROOT = '019c0000-0000-7000-8000-0000000000a1';
const ASKS = '019c0000-0000-7000-8000-0000000000a2';
const STUCK = '019c0000-0000-7000-8000-0000000000a3';
const SECOND_PR = 'https://github.com/acme/demo/pull/8';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-inbox-'));
const { dir: BIN } = fakeGhBin(path.join(tmp, 'bin'));

const facts = (url: string) => ({
  branch: 'topic',
  base: 'main',
  ahead: 1,
  files: 1,
  added: 3,
  removed: 1,
  uncommitted: 0,
  pr: { number: Number(url.split('/').at(-1)), state: 'OPEN', url },
  at: 1,
});
const child = (name: string, url: string, i: number) => ({
  parentId: ROOT,
  name,
  title: name,
  harness: 'codex',
  useWorktree: false,
  cwd: '',
  createdAt: i,
  driven: [],
  lastReport: { how: 'finished', report: 'Opened the PR.', at: i },
  facts: facts(url),
});

test.use({
  harnesses: 'codex',
  shellPath: [BIN],
  env: { PATH: withPath([BIN]) },
  seed: {
    uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } },
    codexThreads: [
      { id: ROOT, name: 'Host UX round', turns: ['Start two sessions'] },
      { id: ASKS, name: 'Sidebar search', turns: ['Search by branch'] },
      { id: STUCK, name: 'Archive worktrees', turns: ['Archive with the family'] },
    ],
    files: ({ userData }) => {
      fs.writeFileSync(
        path.join(userData, 'orchestration.json'),
        JSON.stringify({
          schemaVersion: 1,
          children: { [ASKS]: child('sidebar-search', PR_URL, 1), [STUCK]: child('archive-worktrees', SECOND_PR, 2) },
          parents: {},
          deliveries: {},
          proposals: {},
          queue: [],
          plans: {},
          wrapUps: {
            [ASKS]: {
              recap: 'Search by branch works.',
              ask: 'Keep ⌘⇧F as an alias?',
              actions: [
                { label: 'Keep alias', message: null },
                { label: 'Drop it', message: null },
              ],
            },
          },
          dependants: {},
        }),
      );
    },
  },
});

test('a question counts on its asking session while the parent keeps the family PR tray', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1024, height: 682 });
  const side = page.getByRole('complementary');
  await side.locator(`[data-sidebar-chat="${ROOT}"]`).first().click();
  // each row names its own question, so the person can open the chat that needs the answer
  const asking = side.locator(`[data-sidebar-chat="${ASKS}"]`).first();
  await expect(asking.getByRole('img', { name: '1 request needs you' })).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    side
      .locator(`[data-sidebar-chat="${ROOT}"]`)
      .first()
      .getByRole('img', { name: /requests? needs? you/ }),
  ).toHaveCount(0);
  await expect(
    side
      .locator(`[data-sidebar-chat="${STUCK}"]`)
      .first()
      .getByRole('img', { name: /requests? needs? you/ }),
  ).toHaveCount(0);
  const count = page.getByRole('button', { name: /^Pull requests: (\d+ merged, )?2 open$/ });
  await expect(count).toBeVisible({ timeout: 45_000 });
  await page.screenshot({ path: testInfo.outputPath('count.png') });

  await count.click();
  const tray = page.getByRole('dialog', { name: 'Pull requests' });
  const needs = tray.locator('[data-group="needs"]');
  await expect(needs.getByText('Keep ⌘⇧F as an alias?')).toBeVisible();
  await expect(needs.getByRole('button', { name: 'Open session' })).toBeVisible();
  // red checks nothing fixes are on their way, with their session to open
  await expect(tray.getByRole('region', { name: 'Open' }).getByText('Checks failing · auto-fix is off')).toBeVisible();
  // Let the entrance transform finish before measuring the tray's actual placed edges.
  await expect
    .poll(() =>
      tray.evaluate((el) =>
        el
          .closest('.popover-layer')!
          .getAnimations()
          .some((animation) => animation.playState === 'running'),
      ),
    )
    .toBe(false);
  // The tray may open above or below the count, within the viewport and never over its anchor.
  const [box, countBox, viewport] = await Promise.all([
    tray.boundingBox(),
    count.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  console.log('tray', JSON.stringify(box), 'count', JSON.stringify(countBox), 'viewport', JSON.stringify(viewport));
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  const opensAbove = box!.y + box!.height <= countBox!.y;
  expect(opensAbove || box!.y >= countBox!.y + countBox!.height).toBe(true);
  const anchorGap = opensAbove ? countBox!.y - (box!.y + box!.height) : box!.y - (countBox!.y + countBox!.height);
  await page.screenshot({ path: testInfo.outputPath('tray.png') });

  // All chats: this chat's section, with its one question for the user; back to this chat's list
  await tray.getByRole('button', { name: 'All chats', exact: true }).click();
  const section = tray.getByRole('region', { name: 'Host UX round' });
  await expect(section).toBeVisible();
  await expect(section.getByRole('img', { name: '1 needs you' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('all-chats.png') });
  await tray.getByRole('button', { name: 'This chat', exact: true }).click();
  // the summary panel's card lists the same PRs, so they stay reachable with the PR rail scrolled away
  const card = page.locator('section.summary-group[aria-label="Pull requests"]');
  await expect(card).toBeVisible();
  await expect(card.locator('button.summary-row')).toHaveCount(2);

  // the answer goes to its session as the user's own reply: the row says it went, or, once the session took it and
  // its turn ended, the question is gone and the row shows what is left (its failing checks)
  await tray.getByRole('button', { name: 'Keep alias', exact: true }).click();
  await expect(tray.getByText('Keep ⌘⇧F as an alias?')).toHaveCount(0, { timeout: 30_000 });
  await expect(tray.getByRole('button', { name: 'Keep alias', exact: true })).toHaveCount(0);
  await expect(asking.getByRole('img', { name: /requests? needs? you/ })).toHaveCount(0);
  await expect(count).toBeVisible();
  // As the row shrinks, preserve the edge next to the anchor (the bottom edge when opening above).
  await expect
    .poll(async () => {
      const [after, anchor] = await Promise.all([tray.boundingBox(), count.boundingBox()]);
      if (!after || !anchor) return Number.POSITIVE_INFINITY;
      const gap = opensAbove ? anchor.y - (after.y + after.height) : after.y - (anchor.y + anchor.height);
      return Math.abs(gap - anchorGap);
    })
    .toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('answered.png') });

  // the stuck session's chip opens it
  await tray.getByRole('button', { name: 'archive-worktrees', exact: true }).click();
  await expect(side.locator(`[data-sidebar-chat="${STUCK}"]`).first()).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(tray).toHaveCount(0);

  // the answered session got it as a message
  await side.locator(`[data-sidebar-chat="${ASKS}"]`).first().click();
  await expect(page.getByRole('main').getByText('Keep alias', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('session-got-answer.png') });

  // a PR never sends a system notification (only a session's question does, #3661), so it has no switch either
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).first().click();
  await openSettingsSection(page, 'general');
  await expect(page.locator('.notify-kind', { hasText: 'Task finished' })).toBeVisible();
  await expect(page.locator('.notify-kind', { hasText: /pull request/i })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('settings-switch.png') });
});
