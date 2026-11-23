// MoMo's at-limit rules once the brain's account is known to be out (#2306), on fake Claude Code with its only login out of
// usage (a ".fake-limited" login, fake-claude-limits.mjs, as cuj-errors-limits-offline uses): the first message's turn
// fails on the limit, so main knows it until the reset; then MoMo's main chat (Pause, Next account with no other account)
// holds the next message and says why.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Harness, type Dirs } from './fixtures/app';
import { goToMomoView, momoChat, momoSetupDone, openMomo } from './fixtures/momo';
import { withoutMomoContext } from './fixtures/fake-control-text.mjs';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1' },
  seed: { ...momoSetupDone, files: (d: Dirs) => fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), '') },
});

const TITLE = /as a short chat title/;
const claudeSent = (h: Harness) =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'in' && e.msg?.type === 'user')
    .map((e: any) => {
      const c = e.msg.message?.content;
      return withoutMomoContext(typeof c === 'string' ? c : (c ?? []).map((b: any) => b.text ?? '').join(''));
    })
    .filter((t) => !TITLE.test(t) && t.trim() !== '/usage');

test('a known limit: MoMo’s main chat holds the next message and says why', async ({ page, harness }) => {
  test.setTimeout(120_000);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await openMomo(page);
  await goToMomoView(page, 'Chat');
  const chat = momoChat(page);
  const box = chat.getByRole('textbox', { name: 'Message', exact: true });
  // the first turn fails on the limit: now main knows the login is out until its reset
  await box.fill('plan my week');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('Claude AI usage limit reached', { exact: true })).toBeVisible({ timeout: 20_000 });
  // Pause: the next message is held, and the chat says why
  await box.fill('and my weekend');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText(/MoMo is paused: Claude Code is at its limit until /)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2000);
  // what the harness was sent opens with MoMo's own context block (#2596): the message is what follows it
  const sent = claudeSent(harness).map((t) => t.replace(/^<momo-context>[\s\S]*<\/momo-context>\s+/, ''));
  expect(sent.filter((t) => /plan my week|and my weekend/.test(t))).toEqual(['plan my week']);
  // the held message waits as "Send" (no turn is running to steer into); Retry while the limit stands asks again and the
  // chat says why again, rather than clearing the banner and leaving the message stuck (#2503)
  const chip = chat.locator('.queue-steer');
  await expect(chip).toHaveText('Send');
  await chat.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(chat.getByText(/MoMo is paused: Claude Code is at its limit until /)).toBeVisible({ timeout: 20_000 });
  await expect(chip).toHaveCount(1);
  expect(claudeSent(harness).filter((t) => /and my weekend/.test(t))).toEqual([]);
});
