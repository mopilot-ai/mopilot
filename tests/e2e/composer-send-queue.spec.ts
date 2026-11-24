// Conversation shortcuts in src/components/composer/Composer.tsx send now or queue for later across every harness.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { claudeChatMessages, claudeTextOf } from './fixtures/claudeChat';

for (const family of [
  { label: 'Codex', harnesses: 'codex', acp: {}, defaultHarness: 'codex', log: 'fake-codex.jsonl', steers: true },
  { label: 'Claude Code', harnesses: 'claude', acp: {}, defaultHarness: 'claude', log: 'fake-claude.jsonl', steers: true },
  { label: 'ACP', harnesses: 'none', acp: { opencode: {} }, defaultHarness: 'acp:opencode', log: 'fake-acp-opencode.jsonl', steers: false },
] as const) {
  for (const sendWith of ['enter', 'cmdEnter'] as const) {
    test.describe(`${family.label} conversation shortcuts with ${sendWith}`, () => {
      test.skip(process.platform !== 'darwin', 'ACP admission and native chat controls require macOS');
      test.use({
        harnesses: family.harnesses,
        acp: family.acp,
        seed: { uiState: { prefs: { defaultHarness: family.defaultHarness, followUp: 'steer', sendWith } } },
      });
      test.afterEach(async ({ harness }) => {
        fs.writeFileSync(path.join(harness.dir, `${family.log}.release`), '');
      });

      test('the advertised queue chord holds repeated follow-ups until the current turn ends', async ({ page, harness }) => {
        await page.setViewportSize({ width: 1024, height: 682 });
        const input = page.getByRole('textbox', { name: 'Message', exact: true });
        const sendKey = sendWith === 'enter' ? 'Enter' : 'Meta+Enter';
        const queueKey = sendWith === 'enter' ? 'Meta+Enter' : 'Meta+Shift+Enter';
        const log = path.join(harness.dir, family.log);
        fs.writeFileSync(`${log}.hold-next`, '');
        await input.fill('Keep working while I queue follow-ups');
        await input.press(sendKey);
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await expect.poll(() => fs.existsSync(`${log}.hold-next`)).toBe(false);
        const sendLabel = sendWith === 'enter' ? '⏎' : '⌘⏎';
        const queueLabel = sendWith === 'enter' ? '⌘⏎' : '⇧⌘⏎';
        await expect(input).toHaveAttribute(
          'data-placeholder',
          family.steers ? `${sendLabel} to send, ${queueLabel} to queue for later` : `${sendLabel} to queue for later`,
        );
        const rows = page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem');
        for (const [index, text] of ['First follow-up', 'Second follow-up'].entries()) {
          await input.fill(text);
          await input.press(queueKey);
          await expect(rows).toHaveCount(index + 1);
          await expect(rows.nth(index)).toContainText(text);
          await expect(input).toHaveText('');
        }
        await input.fill('Send this now');
        await input.press(sendKey);
        if (family.harnesses === 'codex') {
          await expect
            .poll(
              () =>
                harness
                  .codexLog()
                  .filter(
                    (entry) =>
                      entry.method === 'turn/steer' && entry.params.input.some((item: { text?: string }) => item.text === 'Send this now'),
                  ).length,
            )
            .toBe(1);
        } else if (family.harnesses === 'claude') {
          await expect
            .poll(() => claudeChatMessages(harness).filter((message) => claudeTextOf(message) === 'Send this now').length)
            .toBe(1);
        } else {
          await expect(rows).toHaveCount(3);
          expect(
            harness
              .acpLog('opencode')
              .filter(
                (entry) =>
                  entry.kind === 'in' &&
                  entry.msg.method === 'session/prompt' &&
                  entry.msg.params.prompt.some((item: { text?: string }) => item.text === 'Send this now'),
              ),
          ).toHaveLength(0);
        }
        fs.writeFileSync(`${log}.release`, '');
        await expect(rows).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        for (const text of ['First follow-up', 'Second follow-up', 'Send this now'])
          await expect(page.locator('.thread-view .user-message').filter({ hasText: text })).toHaveCount(1);
      });
    });
  }
}
