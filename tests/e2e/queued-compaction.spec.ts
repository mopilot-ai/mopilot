// A compact action waits in main's queue through a running turn, removal and window reload on every harness family.
// e2e-covers: src/components/composer/ContextRing.tsx src/components/context/LazyContextPanel.tsx src/components/context/ContextPanel.tsx
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';
import { claudeChatMessages, claudeTextOf } from './fixtures/claudeChat';

const PROBE = '00000000-0000-0000-0000-000000000000';
const families = [
  { label: 'Codex', harnesses: 'codex', acp: {}, defaultHarness: 'codex', log: 'fake-codex.jsonl' },
  { label: 'Claude Code', harnesses: 'claude', acp: {}, defaultHarness: 'claude', log: 'fake-claude.jsonl' },
  {
    label: 'ACP',
    harnesses: 'none',
    acp: { kimi: { usage: true, commands: [{ name: 'compress', description: 'Summarize the context' }] } },
    defaultHarness: 'acp:kimi',
    log: 'fake-acp-kimi.jsonl',
  },
] as const;

function compactions(harness: Harness, family: (typeof families)[number]): unknown[] {
  if (family.harnesses === 'codex')
    return harness.codexLog().filter((entry) => entry.method === 'thread/compact/start' && entry.params.threadId !== PROBE);
  if (family.harnesses === 'claude') return claudeChatMessages(harness).filter((message) => claudeTextOf(message) === '/compact');
  return harness
    .acpLog('kimi')
    .filter(
      (entry) =>
        entry.kind === 'in' &&
        entry.msg.method === 'session/prompt' &&
        entry.msg.params.prompt.map((block: { text?: string }) => block.text ?? '').join('') === '/compress',
    );
}

async function openContext(page: Page) {
  await page.locator('.context-ring').click();
  await page.locator('.ctx-popover').getByRole('button', { name: 'View context', exact: true }).click();
  return page.locator('.dialog', { has: page.getByText('Context', { exact: true }) });
}

for (const family of families) {
  test.describe(`Queued compaction on ${family.label}`, () => {
    test.skip(process.platform !== 'darwin', 'ACP admission and native chat controls require macOS');
    test.use({
      harnesses: family.harnesses,
      acp: family.acp,
      seed: { uiState: { prefs: { defaultHarness: family.defaultHarness, followUp: 'steer' } } },
    });
    test.afterEach(async ({ harness }) => {
      fs.writeFileSync(path.join(harness.dir, `${family.log}.release`), '');
    });

    test('queues, removes, survives reload and compacts only after the current turn finishes', async ({ page, harness }, info) => {
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      const input = page.getByRole('textbox', { name: 'Message', exact: true });
      // Context controls appear after the harness has reported usage for this chat.
      await input.fill('CTXUSE context baseline');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('main').locator('.assistant-message').last()).toContainText('CTXUSE context baseline');
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(page.locator('.context-ring')).toBeVisible();
      const log = path.join(harness.dir, family.log);
      fs.writeFileSync(`${log}.hold-next`, '');
      await input.fill('Keep working while I queue compaction');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      await expect.poll(() => fs.existsSync(`${log}.hold-next`)).toBe(false);

      const context = await openContext(page);
      await context.getByRole('button', { name: 'Compact after turn', exact: true }).click();
      await expect(context.getByRole('button', { name: 'Compaction queued', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      const rows = page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem');
      await expect(rows).toHaveCount(1);
      await expect(rows.getByRole('button', { name: 'After turn', exact: true })).toBeDisabled();
      expect(compactions(harness, family)).toHaveLength(0);

      await rows.getByRole('button', { name: 'Remove from queue', exact: true }).click();
      await expect(rows).toHaveCount(0);
      // The typed native alias follows the same queue, even with ordinary follow-ups set to steer.
      await input.fill(family.harnesses === 'none' ? '/compress' : '/compact');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(rows).toHaveCount(1);
      const chatId = await page.locator('.thread-view[data-thread-id]').getAttribute('data-thread-id');
      expect(chatId).toBeTruthy();
      await page.reload();
      await page
        .locator(`[data-sidebar-chat=${JSON.stringify(chatId)}]`)
        .first()
        .click();
      await expect(rows).toHaveCount(1);
      await openContext(page);
      await expect(context.getByRole('button', { name: 'Compaction queued', exact: true })).toBeDisabled();
      expect(compactions(harness, family)).toHaveLength(0);
      await page.screenshot({ path: info.outputPath('compaction-queued-after-reload.png') });
      await page.keyboard.press('Escape');

      fs.writeFileSync(`${log}.release`, '');
      await expect.poll(() => compactions(harness, family).length).toBe(1);
      await expect(rows).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await openContext(page);
      await expect(context.getByRole('button', { name: 'Compact now', exact: true })).toBeEnabled();
    });
  });
}
