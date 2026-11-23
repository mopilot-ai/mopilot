// Replays the reported two background-limit replies through the real SDK and checks one actionable status after reload.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Dirs } from './fixtures/app';
import { claudeLimitNotifications, CLAUDE_LIMIT_TEXT } from '../fixtures/claude-limit-notifications.mjs';

const sessionId = '43434343-1111-4222-8333-444444444444';
const title = 'Background limits';
test.use({
  harnesses: 'claude',
  seed: {
    uiState: { prefs: { fontSize: 24, zoomLevel: 0 } },
    files: (d: Dirs) => {
      const cwd = path.join(d.home, 'project');
      const dir = path.join(d.claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(dir, { recursive: true });
      const records = claudeLimitNotifications().map((m) => ({ ...m, cwd, sessionId, version: '2.1.295', isSidechain: false }));
      fs.writeFileSync(
        path.join(dir, `${sessionId}.jsonl`),
        [...records, { type: 'custom-title', customTitle: title, sessionId }].map((m) => JSON.stringify(m)).join('\n') + '\n',
      );
      fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), '');
    },
  },
});

test('background quota replies become one limit status with reset time and recovery, including after reload', async ({ page, harness }) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await page.getByRole('complementary').getByText(title, { exact: true }).first().click();
  await expect.poll(() => page.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--fs-chat'))).toBe('24px');
  const transcript = page.getByRole('main');
  const notes = transcript.locator('.status-note.limit');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(notes).toHaveCount(1);
  await expect(notes).toContainText(CLAUDE_LIMIT_TEXT);
  await expect(notes.getByRole('button', { name: 'Set up Codex', exact: true })).toBeVisible();
  await expect(transcript.locator('.assistant-message')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await notes.scrollIntoViewIfNeeded();
  await expect(notes).toBeVisible();
  await expect(notes.getByRole('button')).toBeInViewport();
  const layout = await notes.evaluate((el) => {
    const text = el.querySelector('.step-text') as HTMLElement;
    const icon = el.querySelector('.step-icon')!;
    const textRect = text.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    return {
      clipped: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1,
      iconOffset: Math.abs(iconRect.y + iconRect.height / 2 - textRect.y - parseFloat(getComputedStyle(text).lineHeight) / 2),
    };
  });
  expect(layout.clipped, 'the reset time must be readable in the narrow chat beside the open panels').toBe(false);
  expect(layout.iconOffset, 'the quota icon follows the first line at the larger chat font').toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('limit-status-large-font.png') });
  await page.reload();
  await page.getByRole('complementary').getByText(title, { exact: true }).first().click();
  await expect(notes).toHaveCount(1);
  await expect(notes).toContainText(CLAUDE_LIMIT_TEXT);
  await composer.fill('Try again');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(notes).toHaveCount(2);
  await expect(notes.last()).toContainText('Claude AI usage limit reached');
  await expect(transcript.locator('.assistant-message')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await notes.last().getByRole('button', { name: 'Set up Codex', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Codex', exact: true })).toBeVisible();
});
