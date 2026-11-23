// Reloading a running chat restores earlier prompts and stopped work while preserving items arriving during the read.
// e2e-covers: src/store/codexOpen.ts src/store/transcriptRead.ts src/store/threads.ts
import { test, expect } from './fixtures/app';
import { HISTORY_DELTA } from './fixtures/fake-codex-history.mjs';
import fs from 'node:fs';

const CHAT = '019c0000-0000-7000-8000-000000006b69';
const prompt = (n: number) => `Earlier user request ${n}\n\n` + 'Keep this conversation and all its evidence.\n\n'.repeat(12);
const turns = Array.from({ length: 3 }, (_, n) => ({
  text: prompt(n),
  status: n === 0 ? 'interrupted' : 'completed',
  items: [
    { type: 'userMessage', id: `user-${n}`, content: [{ type: 'text', text: prompt(n), text_elements: [] }] },
    { type: 'agentMessage', id: `update-${n}`, text: `Earlier assistant update ${n}`, phase: 'commentary' },
    {
      type: 'commandExecution',
      id: `tool-${n}`,
      command: 'Inspect earlier evidence',
      cwd: '/tmp',
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'Earlier tool evidence',
      exitCode: 0,
      durationMs: 1,
    },
    ...(n ? [{ type: 'agentMessage', id: `final-${n}`, text: `Earlier final answer ${n}`, phase: 'final_answer' }] : []),
  ],
}));
test.use({
  harnesses: 'codex',
  env: { FAKE_CODEX_THREADS: JSON.stringify([{ id: CHAT, name: 'History recovery', turns }]) },
  seed: { uiState: { summaryOpen: true, prefs: { fontSize: 14, zoomLevel: 1 } } },
});

test('earlier conversation returns when a live reply retires the first history read after reload', async ({ harness, page }, info) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await page.getByRole('complementary').getByRole('button', { name: 'History recovery', exact: true }).first().click();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('SLOW continue the conversation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const reply = 'fake-codex: SLOW continue the conversation';
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  fs.writeFileSync(`${harness.env.FAKE_CODEX_LOG}.history-race-${CHAT}`, 'race');
  await page.reload();
  await page.getByRole('complementary').getByRole('button', { name: 'History recovery', exact: true }).first().click();
  await expect.poll(() => harness.codexLog().filter((entry) => entry.method === 'fixture/historyRace').length).toBe(1);
  const transcript = page.getByRole('region', { name: 'Conversation transcript', exact: true });
  await expect(page.getByText(reply + HISTORY_DELTA, { exact: true })).toBeVisible();
  await transcript.focus();
  await page.keyboard.press('Home');
  await expect(page.getByText(prompt(0), { exact: true })).toBeVisible();
  await transcript
    .getByRole('button', { name: /Stopped/ })
    .first()
    .click();
  await expect(page.getByText('Earlier assistant update 0', { exact: true })).toBeVisible();
  const tool = transcript.getByRole('button', { name: /^Ran Inspect earlier evidence/ });
  await expect(tool).toBeVisible();
  await tool.click();
  await expect(page.getByText('Earlier tool evidence', { exact: true })).toBeVisible();
  await transcript.focus();
  await page.keyboard.press('End');
  await expect(page.getByText(reply + HISTORY_DELTA, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('history-restored.png') });
});
