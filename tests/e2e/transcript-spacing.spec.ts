// The reported transcript rhythm and running-command spacing, using the real renderer and fake Codex/GitHub.
// Exercises 'src/styles/app/thread.css', 'src/styles/app/thread-messages.css' and 'src/styles/app/markdown.css'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { openCompletedTurnWork } from './fixtures/turnWork';
import { withPath } from './fixtures/nodeCommand';

const ROOT = '019c0000-0000-7000-8000-0000000000d1';
const CHILD = '019c0000-0000-7000-8000-0000000000d2';
const PROMPT = 'Review the transcript spacing';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-spacing-'));
const { dir: BIN } = fakeGhBin(path.join(tmp, 'bin'));
const reply = (id: string, text: string, phase = 'commentary') => ({ type: 'agentMessage', id, text, phase });
const command = (id: string, text: string) => ({
  type: 'commandExecution',
  id,
  command: text,
  cwd: '/tmp',
  processId: null,
  source: 'agent',
  status: 'completed',
  commandActions: [],
  aggregatedOutput: '',
  exitCode: 0,
  durationMs: 1,
});

test.afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

for (const [fontSize, theme] of [
  [14, 'dark'],
  [18, 'dark'],
  [24, 'dark'],
  [14, 'light'],
] as const) {
  test.describe(`transcript spacing at ${fontSize}px in ${theme}`, () => {
    test.use({
      harnesses: 'codex',
      shellPath: [BIN],
      env: {
        PATH: withPath([BIN]),
        FAKE_CODEX_THREADS: JSON.stringify([
          {
            id: ROOT,
            name: 'Transcript spacing',
            turns: [
              {
                text: PROMPT,
                items: [
                  { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: PROMPT, text_elements: [] }] },
                  command('first-command', 'git status'),
                  reply('first-update', `Before the linked update.\n[View the PR](${PR_URL})\nAfter the linked update.`),
                  command('second-command', 'npm test'),
                  reply('second-update', 'The focused tests pass. The next update has a clear break above it.'),
                  reply('final', 'Spacing review complete.', 'final_answer'),
                ],
              },
            ],
          },
          { id: CHILD, name: 'Spacing follow-up', turns: ['Check the layout'] },
        ]),
      },
      seed: {
        uiState: { prefs: { fontSize, zoomLevel: 0, theme } },
        files: ({ userData }) =>
          fs.writeFileSync(
            path.join(userData, 'orchestration.json'),
            JSON.stringify({
              schemaVersion: 1,
              children: {
                [CHILD]: {
                  parentId: ROOT,
                  name: 'spacing-follow-up',
                  title: 'Spacing follow-up',
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
                    added: 1,
                    removed: 0,
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
              wrapUps: {},
              dependants: {},
            }),
          ),
      },
    });

    test('updates have a reading rhythm and inline PRs preserve the text line height', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      await page.getByRole('complementary').locator(`[data-sidebar-chat="${ROOT}"]`).first().click();
      const turn = await openCompletedTurnWork(page, PROMPT);
      const chip = turn.locator('.md-pr-chip');
      await expect(chip.locator('.md-pr-chip-title')).toHaveText('Fix the parser');
      for (const width of [1024, 1440]) {
        await page.setViewportSize({ width, height: 682 });
        const gaps = () =>
          turn.locator('.work').evaluate((work) => {
            const updates = [...work.querySelectorAll('.commentary')];
            const first = updates[0].getBoundingClientRect();
            const second = updates[1].getBoundingClientRect();
            const summary = updates[1].previousElementSibling!.getBoundingClientRect();
            return { related: second.top - summary.bottom, separate: summary.top - first.bottom };
          });
        // Expanding completed work animates its grid; measure the settled geometry without a fixed delay.
        await expect.poll(async () => (await gaps()).related).toBeCloseTo(12, 1);
        await expect.poll(async () => (await gaps()).separate).toBeCloseTo(20, 1);
        const leading = await turn
          .locator('.commentary p')
          .first()
          .evaluate((el) => {
            const line = Number.parseFloat(getComputedStyle(el).lineHeight);
            return el.getBoundingClientRect().height / line;
          });
        expect(leading, 'an inline PR should keep the same three line boxes as plain text').toBeCloseTo(3, 1);
        await page.screenshot({ path: testInfo.outputPath(`updates-${width}.png`) });
      }
    });

    test('running activity carries the PR count and has clear space above the composer', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      await page.getByRole('complementary').locator(`[data-sidebar-chat="${ROOT}"]`).first().click();
      const prCount = page.getByRole('button', { name: 'Pull requests: 1 open' });
      await expect(prCount).toHaveText('1 open PR', { timeout: 45_000 });
      await prCount.click();
      await expect(page.getByRole('dialog', { name: 'Pull requests' })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: testInfo.outputPath('completed-pr-count.png') });
      const input = page.getByRole('textbox', { name: 'Message', exact: true });
      await input.fill(
        `SLOW HOLDREPLY BGTERM\nMCPCU update_task_list ${JSON.stringify({
          items: Array.from({ length: 12 }, (_, i) => ({
            content: `Check transcript spacing for update ${i + 1}`,
            status: i === 0 ? 'in_progress' : 'pending',
          })),
        })}`,
      );
      await input.press('Enter');
      const activity = page.locator('.turn-status-slot .claude-activity');
      await expect(activity).toBeVisible();
      await expect(page.getByRole('region', { name: 'Task list' })).toBeVisible();
      await expect(page.locator('.turn-status-slot').getByRole('button', { name: 'Pull requests: 1 open' })).toHaveCount(0);
      await expect(
        page.getByRole('region', { name: 'Chat pull requests' }).getByRole('button', { name: 'Pull requests: 1 open' }),
      ).toHaveText('1 open PR');
      for (const width of [1024, 1440]) {
        await page.setViewportSize({ width, height: 682 });
        await page.locator('.thread-scroll').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await expect
          .poll(async () => {
            const [row, composer] = await Promise.all([activity.boundingBox(), input.boundingBox()]);
            return composer!.y - row!.y - row!.height;
          })
          .toBeGreaterThanOrEqual(24);
        await page.screenshot({ path: testInfo.outputPath(`running-${width}.png`) });
      }
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(activity).toHaveCount(0);
      await expect(prCount).toHaveText('1 open PR');
    });
  });
}
