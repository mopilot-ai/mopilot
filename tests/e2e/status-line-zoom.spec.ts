// A running turn's status line at every app zoom: the clock and chevron never sit on the counts after them, and nothing
// runs past the chat's pane. A zoomed window has fewer CSS pixels, so this is the line's narrow case too. The shell
// gives way as well (#4065): the summary hides, then the sidebar, the chat keeps following its end, and the user's own
// choice comes back with the room, or opens a panel anyway.
// Covers 'src/styles/app/motion.css' and 'src/styles/tasks-pane.css'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { MAX_ZOOM_LEVEL } from '../../shared/zoom.mjs';
import { CHAT_MIN_WIDTH } from '../../src/lib/splitClamp';
import { test, expect, type Harness } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

test.skip(process.platform !== 'darwin', 'the Claude fake reaches its tools through sage-mcp, which builds only on macOS');

const ROOT = '019c0000-0000-7000-8000-0000000000b1';
const CHILD = '019c0000-0000-7000-8000-0000000000b2';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-line-zoom-'));
const { dir: BIN } = fakeGhBin(path.join(tmp, 'bin'));

test.use({
  harnesses: 'both',
  shellPath: [BIN],
  env: { PATH: withPath([BIN]) },
  seed: {
    claudeSessions: [{ id: ROOT, cwd: 'work', title: 'Status line', turns: ['Start a session'] }],
    codexThreads: [{ id: CHILD, name: 'Open a PR', turns: ['Open a PR'] }],
    files: ({ userData }) => {
      fs.writeFileSync(
        path.join(userData, 'orchestration.json'),
        JSON.stringify({
          schemaVersion: 1,
          children: {
            [CHILD]: {
              parentId: `claude:${ROOT}`,
              name: 'open-a-pr',
              title: 'open-a-pr',
              harness: 'codex',
              useWorktree: false,
              cwd: '',
              createdAt: 1,
              driven: [],
              lastReport: { how: 'finished', report: 'Opened the PR.', at: 1 },
              facts: {
                branch: 'topic',
                base: 'main',
                ahead: 1,
                files: 1,
                added: 3,
                removed: 1,
                uncommitted: 0,
                pr: { number: 7, state: 'OPEN', url: PR_URL },
                at: 1,
              },
            },
          },
          parents: {},
          deliveries: {},
          proposals: {},
          queue: [],
          plans: {},
          wrapUps: { [CHILD]: { recap: 'Opened the PR.', ask: 'Merge it now?', actions: [{ label: 'Merge', message: null }] } },
          dependants: {},
        }),
      );
    },
  },
});

const setZoom = (h: Harness, level: number) =>
  h.app.evaluate(({ BrowserWindow }, l) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomLevel(l);
  }, level);

/** What the window really shows: Playwright's own screenshot crops a zoomed Electron page. */
const capture = (h: Harness, file: string) =>
  h.app.evaluate(async ({ BrowserWindow }, f) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    process.getBuiltinModule('node:fs').writeFileSync(f, image.toPNG());
  }, file);

/** The line's pieces that paint text or an icon, inset by a ghost button's padding, and what overlaps or overflows. */
function measureLine(page: Page) {
  return page.evaluate(() => {
    const line = document.querySelector('.claude-step-head')!;
    // a new turn holds the question at the top rather than following the end, so in a very short window the line can
    // sit below the view: the reader scrolls to it, and then nothing may cover it
    line.scrollIntoView({ block: 'nearest' });
    const pieces = [
      ...line.querySelectorAll('.claude-activity-mark, .claude-activity-label, .claude-activity-time, .claude-activity-chevron'),
      ...line.querySelectorAll('.tasks-count-inline > *'),
    ].map((el) => {
      const box = el.getBoundingClientRect();
      const inset = el.classList.contains('tasks-count') ? 6 : 0;
      return {
        name: el.textContent || el.getAttribute('class'),
        left: box.left + inset,
        right: box.right - inset,
        top: box.top,
        bottom: box.bottom,
      };
    });
    const overlaps: string[] = [];
    for (const [i, a] of pieces.entries())
      for (const b of pieces.slice(i + 1))
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)
          overlaps.push(`${a.name} over ${b.name}`);
    const pane = line.closest('[aria-label="Primary pane"]')!.getBoundingClientRect();
    // what is really on top at the clock and each count: nothing else may paint over the line, the composer included
    const covered = [line.querySelector('.claude-activity-time')!, ...line.querySelectorAll('.tasks-count')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        // Scroll to bottom floats over the transcript by design, and in a very short window it can sit on the line
        const onTop = document
          .elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          .find((hit) => !hit.closest('.scroll-bottom'));
        return !onTop || !el.contains(onTop);
      })
      .map((el) => {
        const box = el.getBoundingClientRect();
        const onTop = document
          .elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          .find((hit) => !hit.closest('.scroll-bottom'));
        return `${el.textContent} at ${Math.round(box.top)} under ${onTop?.className || onTop?.tagName || 'nothing'}`;
      });
    const scroller = line.closest('.thread-scroll');
    const where = scroller && {
      top: Math.round(scroller.scrollTop),
      height: scroller.scrollHeight,
      view: scroller.clientHeight,
      following: scroller.classList.contains('following'),
      windowHeight: window.innerHeight,
    };
    return {
      overlaps,
      covered,
      where,
      chatWidth: pane.width,
      windowWidth: window.innerWidth,
      summary: !!document.querySelector('.summary-slot'),
      sidebar: !!document.querySelector('aside, [role="complementary"]'),
      paneWidth: pane.width,
      pastEdge: Math.max(...pieces.map((p) => p.right)) - pane.right,
    };
  });
}

test('the running line stays readable at every zoom', async ({ page, harness }, testInfo) => {
  test.setTimeout(120_000);
  await page.getByRole('complementary').getByText('Status line', { exact: true }).first().click();
  await expect(page.getByRole('button', { name: /^Pull requests: / })).toBeVisible({ timeout: 45_000 });

  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('RUNCMDSTREAM run the suite');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .locator('.approval-card')
    .getByRole('button', { name: /Allow once/ })
    .click();
  const head = page.locator('.claude-step-head').filter({ has: page.locator('.tasks-count-inline') });
  // the row's clock joins after five seconds
  await expect(head.locator('.claude-activity-time')).toBeVisible({ timeout: 20_000 });

  const summary = page.locator('.summary-slot');
  const sidebar = page.getByRole('complementary');
  for (let level = 0; level <= MAX_ZOOM_LEVEL; level += 1) {
    await setZoom(harness, level);
    // a panel that gives way leaves with its exit animation: measure once the chat has its room
    await expect
      .poll(async () => {
        const now = await measureLine(page);
        return now.chatWidth >= Math.min(CHAT_MIN_WIDTH, now.windowWidth) - 1;
      })
      .toBe(true);
    const fit = await measureLine(page);
    await capture(harness, testInfo.outputPath(`zoom-${level}.png`));
    console.log(`zoom ${level}`, JSON.stringify(fit));
    expect(fit.overlaps, `level ${level}`).toEqual([]);
    expect(fit.covered, `level ${level}`).toEqual([]);
    expect(fit.pastEdge, `level ${level}`).toBeLessThanOrEqual(0);
    // the chat keeps its minimum while the window has it: the panels give way, not the chat
    expect(fit.chatWidth, `level ${level}`).toBeGreaterThanOrEqual(Math.min(CHAT_MIN_WIDTH, fit.windowWidth) - 1);
    await expect(head.getByRole('button', { name: '1 session needs you' })).toBeVisible();
    await expect(head.getByRole('button', { name: /^Pull requests: / })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Chat pull requests' })).toBeAttached();
  }
  // the room back, the panels the user had open are back: hiding them never changed the choice
  await setZoom(harness, 0);
  await expect(summary).toBeVisible();
  await expect(sidebar).toBeVisible();

  // where the summary no longer fits, its button still opens it, and hides it again
  await setZoom(harness, 3);
  await expect(summary).toHaveCount(0);
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(summary).toBeVisible();
  await capture(harness, testInfo.outputPath('opened-anyway.png'));
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(summary).toHaveCount(0);
  await setZoom(harness, 0);
  await expect(summary).toHaveCount(0);
  harness.releaseClaudeCommand();
});
