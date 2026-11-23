// Manual reading after a tool-heavy turn stops stays usable through folding work and later replies.
// e2e-covers: src/components/thread/ThreadView.tsx src/lib/streamScroll.ts src/components/thread/view/turnWindow.tsx
import { test, expect } from './fixtures/app';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHAT = '019c0000-0000-7000-8000-000000006b68';
const prompt = (n: number) =>
  `Repair step ${n}\n\n` +
  Array.from({ length: 12 }, (_, i) => `Requirement ${i}: preserve the conversation while investigating the failure.`).join('\n\n');
const turns = Array.from({ length: 3 }, (_, n) => ({
  text: prompt(n),
  items: [
    { type: 'userMessage', id: `user-${n}`, content: [{ type: 'text', text: prompt(n), text_elements: [] }] },
    ...Array.from({ length: 20 }, (_, i) => ({
      type: 'commandExecution',
      id: `command-${n}-${i}`,
      command: `Inspect repair evidence ${i}`,
      cwd: '/tmp',
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: `Evidence ${i}\n`.repeat(200),
      exitCode: 0,
      durationMs: 1,
    })),
    { type: 'agentMessage', id: `reply-${n}`, text: `Repair step ${n} has stopped.`, phase: 'final_answer' },
  ],
}));
const seedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-scroll-'));
const seedFile = path.join(seedDirectory, 'threads.json');
fs.writeFileSync(seedFile, JSON.stringify([{ id: CHAT, name: 'Manual scrolling', turns }]));
test.afterAll(() => fs.rmSync(seedDirectory, { recursive: true, force: true }));

for (const fontSize of [14, 24]) {
  test.describe(`manual transcript scrolling at ${fontSize}px`, () => {
    test.use({
      harnesses: 'codex',
      env: { FAKE_CODEX_THREADS: `@${seedFile}` },
      seed: { uiState: { summaryOpen: true, prefs: { fontSize, zoomLevel: 1 } } },
    });

    test('a stopped conversation can be read in both directions and after another reply', async ({ page }, info) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      await page.getByRole('complementary').getByRole('button', { name: 'Manual scrolling', exact: true }).first().click();
      const transcript = page.getByRole('region', { name: 'Conversation transcript', exact: true });
      const gap = () => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
      await expect.poll(() => transcript.evaluate((el) => el.clientHeight)).toBeGreaterThan(100);
      await expect.poll(gap).toBeLessThanOrEqual(1);

      const input = page.getByRole('textbox', { name: 'Message', exact: true });
      await input.fill('SLOW continue the repair');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

      await transcript.hover();
      await page.mouse.wheel(0, -400);
      await expect.poll(gap).toBeGreaterThan(100);
      const before = await transcript.evaluate((el) => el.scrollTop);
      await page.mouse.wheel(0, -400);
      await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeLessThan(before - 100);
      await page.mouse.wheel(0, 200);
      await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(before - 350);

      await transcript.focus();
      await page.keyboard.press('Home');
      await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(1);
      await expect(page.getByText(prompt(0), { exact: true })).toBeVisible();
      await page.keyboard.press('End');
      await expect.poll(gap).toBeLessThanOrEqual(1);

      await input.fill('The repair remains readable');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText('fake-codex: The repair remains readable', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await transcript.hover();
      await page.mouse.wheel(0, -400);
      await expect.poll(gap).toBeGreaterThan(100);
      await page.screenshot({ path: info.outputPath('manual-transcript-scroll.png') });
    });
  });
}
