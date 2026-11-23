// MoMo's main chat after an app restart that never saw a first message (#2502), on fake Claude Code that, like the real CLI,
// refuses to resume a session with no transcript: opening MoMo made its chat but no message started a session, and after the
// restart a message must still be answered (on a new conversation), never "No conversation found with session ID".
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { goToMomoView, momoChat, momoSetupDone, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1', FAKE_CLAUDE_STRICT_RESUME: '1' }, seed: momoSetupDone });

test('a MoMo chat no message ever started is replaced after a restart, and the next message is answered', async ({ page, harness }) => {
  test.setTimeout(240_000);
  await openMomo(page);
  await goToMomoView(page, 'Chat');
  await expect(momoChat(page).getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  const state = path.join(harness.env.MOPILOT_USER_DATA ?? path.join(harness.dir, 'userData'), 'momo', 'state.json');
  await expect.poll(() => fs.existsSync(state), { timeout: 15_000 }).toBe(true);
  const before = JSON.parse(fs.readFileSync(state, 'utf8')).mainChatId;
  // restart: the chat is saved, its session never started
  await harness.quit();
  await harness.relaunch();
  const next = harness.page;
  await openMomo(next);
  await goToMomoView(next, 'Chat');
  const chat = momoChat(next);
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('plan my week please');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  // the message reached a CLI that started a session, and no error card stands
  await expect
    .poll(
      () =>
        harness
          .claudeLog()
          .filter((e) => e.kind === 'in' && e.msg?.type === 'user')
          .map((e: any) => JSON.stringify(e.msg.message?.content))
          .some((t: string) => t.includes('plan my week please')),
      { timeout: 30_000 },
    )
    .toBe(true);
  // MoMo is on a new chat: the old one's session never existed
  expect(JSON.parse(fs.readFileSync(state, 'utf8')).mainChatId).not.toBe(before);
  await expect(chat.getByText(/No conversation found/)).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});
