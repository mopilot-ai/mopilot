// Native scheduled-run reports show readable Markdown in the real renderer, including repeated history and copy.
// e2e-covers: shared/heartbeatMessage.mjs shared/codexDirectives.mjs src/components/markdown/Markdown.tsx src/components/thread/view/MessageActions.tsx
import { test, expect } from './fixtures/app';

const CHAT = '019c0000-0000-7000-8000-0000000000e1';
const report = (n: number) => `Promoted **${n} changes**.\n\nCounts and validation passed.\n\n[Report](/tmp/report-${n}.json)`;
const heartbeat = (n: number) =>
  `<heartbeat>\n<automation_id>daily-question-generation-and-local-promotion</automation_id>\n<decision>NOTIFY</decision>\n<message>${report(n)}</message>\n</heartbeat>`;

for (const fontSize of [14, 24]) {
  test.describe(`heartbeat reports at ${fontSize}px`, () => {
    test.use({
      harnesses: 'codex',
      seed: { uiState: { prefs: { fontSize, zoomLevel: 0, theme: 'dark' } } },
      env: {
        FAKE_CODEX_THREADS: JSON.stringify([
          {
            id: CHAT,
            name: 'Daily automation reports',
            turns: [1, 2].map((n) => ({
              text: `Scheduled run ${n}`,
              items: [
                { type: 'userMessage', id: `user-${n}`, content: [{ type: 'text', text: `Scheduled run ${n}` }] },
                { type: 'agentMessage', id: `reply-${n}`, phase: 'final_answer', text: heartbeat(n) },
              ],
            })),
          },
        ]),
      },
    });

    test('saved heartbeat reports render and copy without internal tags after opening and reloading', async ({ page, harness }, info) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        // Reload resets the window route; reopen the saved chat to read its history again.
        await page.getByRole('complementary').locator(`[data-sidebar-chat="${CHAT}"]`).first().click();
        const replies = page.locator('.assistant-message');
        await expect(replies).toHaveCount(2);
        for (const n of [1, 2]) {
          const reply = replies.nth(n - 1);
          await expect(reply.locator('strong')).toHaveText(`${n} changes`);
          await expect(reply).not.toContainText('<heartbeat>');
          await expect(reply).not.toContainText('NOTIFY');
          await expect(reply.getByRole('link', { name: 'Report', exact: true })).toHaveAttribute('href', `/tmp/report-${n}.json`);
        }
      }
      await page.locator('.message-actions').last().getByRole('button', { name: 'Copy', exact: true }).click();
      await expect.poll(() => harness.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(report(2));
      await page.screenshot({ path: info.outputPath('heartbeat-reports.png') });
    });
  });
}
