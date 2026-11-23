// Sidebar PR badges draw one mark per state (draft checks, rings, a dot cut into its glyph on selected rows), and status dots keep their own look.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const CHAT = '019c0000-0000-7000-8000-0000000000a1';
const KID = '019c0000-0000-7000-8000-0000000000a2';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-marks-'));
const { dir: BIN } = fakeGhBin(path.join(root, 'bin'));
const prState = path.join(root, 'pr.json');
const failing = [{ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'FAILURE' }];
const passing = [{ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' }];

/** A row-dot of `status` added to the sidebar, its pulse paused at its peak: the opacity the app's stylesheet gives it. */
async function peakOpacity(page: Page, status: string) {
  return page.evaluate((status) => {
    const dot = document.createElement('span');
    dot.className = `row-dot ${status}`;
    document.querySelector('[data-sidebar-chat]')!.append(dot);
    const [pulse] = dot.getAnimations();
    if (!pulse) throw new Error(`.row-dot.${status} has no pulse animation`);
    pulse.pause();
    pulse.currentTime = 750;
    const opacity = getComputedStyle(dot).opacity;
    dot.remove();
    return Number(opacity);
  }, status);
}

test.use({
  harnesses: 'codex',
  shellPath: [BIN],
  env: { PATH: withPath([BIN]), FAKE_GH_STATE_FILE: prState },
  seed: {
    codexThreads: [
      { id: CHAT, name: 'A pull request', turns: [`Opened pull request ${PR_URL}`] },
      { id: KID, name: 'A failed session', turns: ['It did not work out'] },
    ],
    uiState: { prefs: { zoomLevel: 0 } },
    files: ({ userData }) => {
      fs.writeFileSync(
        path.join(userData, 'orchestration.json'),
        JSON.stringify({
          schemaVersion: 1,
          children: {
            [KID]: {
              parentId: 'gone',
              name: 'worker',
              title: 'A failed session',
              harness: 'codex',
              useWorktree: false,
              createdAt: 1,
              driven: [],
              lastReport: { how: 'failed', report: null, chars: 0, at: 1 },
            },
          },
          parents: {},
          deliveries: {},
          proposals: {},
          queue: [],
          plans: {},
          wrapUps: {},
          dependants: {},
        }),
      );
    },
  },
});

test('each PR state draws its own mark, the dot shows the row behind it, and failures and dimming keep their look', async ({
  page,
}, testInfo) => {
  fs.writeFileSync(prState, JSON.stringify({ isDraft: true, mergeStateStatus: 'DRAFT', statusCheckRollup: failing }));
  await page.setViewportSize({ width: 1024, height: 682 });
  const sidebar = page.getByRole('complementary');
  const row = sidebar.locator(`[data-sidebar-chat="${CHAT}"]`).first();
  const badge = row.locator('.thread-pr-badge');
  const dot = badge.locator('.thread-pr-dot');

  // a draft shows its failing checks
  await expect(badge).toHaveClass(/\bdraft\b/);
  await expect(dot).toHaveClass(/\bfailing\b/);
  await expect(badge).toHaveAttribute('aria-label', /draft · checks failing/);

  // conflicts and passed-but-blocked checks are rings; ready to merge is solid
  for (const [snapshot, mark, label, ring] of [
    [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: passing }, 'conflict', 'open · merge conflicts', true],
    [{ mergeStateStatus: 'BLOCKED', statusCheckRollup: passing }, 'passing', 'open · checks passed', true],
    [{ mergeStateStatus: 'CLEAN', statusCheckRollup: passing }, 'ready', 'open · ready to merge', false],
  ] as const) {
    fs.writeFileSync(prState, JSON.stringify(snapshot));
    await page.reload();
    await expect(dot).toHaveClass(new RegExp(`\\b${mark}\\b`));
    await expect(badge).toHaveAttribute('aria-label', new RegExp(label));
    await expect(dot).toHaveCSS('background-image', 'none');
    if (ring) await expect(dot).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    else await expect(dot).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(dot).toHaveCSS('outline-style', 'none');
  }

  // on a selected row the dot sits in a hole cut from the glyph, with the row's own background around it
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'page');
  await expect(badge.locator('svg')).toHaveCSS('mask-image', /radial-gradient/);
  await row.hover();
  await badge.screenshot({ path: testInfo.outputPath('selected-badge.png') });

  // the hover card's glyph is the badge's color
  await badge.hover();
  const cardGlyph = page.locator('.tooltip.rich .thread-pr-list-state svg').first();
  await expect(cardGlyph).toBeVisible();
  const glyphColor = await badge.evaluate((el) => getComputedStyle(el).color);
  await expect(cardGlyph).toHaveCSS('color', glyphColor);
  await page.screenshot({ path: testInfo.outputPath('hover-card.png') });
  await page.mouse.move(900, 40);

  // a linked session whose last report failed is a red alert with a tooltip, like a failed chat
  const kid = sidebar.locator(`[data-sidebar-chat="${KID}"]`).first();
  await expect(kid.locator('.row-status.error [aria-label="Failed"]')).toBeVisible();

  // a chat running elsewhere pulses at its own 60% dimming; a working one at full strength
  expect(await peakOpacity(page, 'elsewhere')).toBeCloseTo(0.6, 2);
  expect(await peakOpacity(page, 'working')).toBeCloseTo(1, 2);
});
