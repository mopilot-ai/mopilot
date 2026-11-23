// MoMo's earlier main chats and Paused, on the Muse-style shell (#2139), on fakes only (Codex, with opencode as the fake ACP
// brain to move to): MoMo is paused (prefs.momo.paused), so its identity says "Paused · Resume" and Resume clears it in
// place; moving MoMo's brain keeps the same main chat, which goes on on the new brain after a switch divider (#2489), so
// nothing new is listed under Earlier. An earlier main chat (one an older build's brain change replaced, seeded here) is
// listed under Earlier in MoMo's navigation with the harness it ran on; opening it shows the conversation read-only (no
// composer, "An earlier conversation · Read only"), Chat in the navigation is not marked while it is open, and Chat goes
// back to the main chat, which takes messages.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { momoChat, momoNav, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const MODE = {
  id: 'mode',
  name: 'Mode',
  type: 'select',
  currentValue: 'build',
  options: [
    { value: 'build', name: 'Build' },
    { value: 'momo', name: 'MoMo' },
  ],
};
// opencode is MoMo's brain only with a provider of its own (free models alone can't run MoMo, #2357)
const files = ({ home }: { home: string }) => {
  fs.mkdirSync(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    JSON.stringify({ anthropic: { type: 'api', key: 'test' } }),
  );
};
// an earlier main chat on Codex, as a brain change before #2489 left it: MoMo's ('previous'), with its thread's conversation
const EARLIER = '019a0000-0000-7000-8000-0000000000e1';
const earlierRecord = {
  schemaVersion: 2,
  id: EARLIER,
  segments: [{ kind: 'codex', nativeId: EARLIER, instance: null, provider: null, model: null, handoff: null, start: 0, count: null }],
  meta: {
    archived: null,
    pinned: false,
    unread: false,
    projectId: null,
    worktreeOf: null,
    account: null,
    config: null,
    goalHeld: null,
    notes: [],
    computerGrants: [],
    navigationBookmarks: [],
    forkOf: null,
    controllerPlan: null,
    activeAt: null,
    momo: 'previous',
    routineId: null,
    topicId: null,
    momoModel: null,
    authored: null,
  },
  updatedAt: 1760000000000,
};

test.describe('MoMo: Paused, and its earlier chats', () => {
  test.use({
    harnesses: 'codex',
    acp: { opencode: { configOptions: [MODE] } },
    seed: {
      files,
      threads: { [`${EARLIER}.v2`]: earlierRecord },
      codexThreads: [{ id: EARLIER, turns: ['remember the first chat'] }],
      uiState: { prefs: { momo: { onboarding: { done: true, step: 0 }, paused: true } } },
    },
    env: { MOPILOT_MOMO_DEV: '1' },
  });

  test('Resume clears Paused; a brain change keeps the chat; an earlier chat opens read-only, and Chat goes back', async ({ page }) => {
    await openMomo(page);
    const chat = momoChat(page);
    const box = chat.getByRole('textbox', { name: 'Message', exact: true });
    const send = chat.getByRole('button', { name: 'Send', exact: true });
    const identity = chat.locator('header [role=status]');
    const earlier = momoNav(page).getByRole('button', { name: /^Codex/ });
    await expect(box).toBeVisible({ timeout: 15_000 });

    // paused: said in the identity, with Resume right there; the earlier chat is listed under Earlier
    await expect(identity).toContainText('Paused');
    await expect(momoNav(page).getByText('Earlier', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(earlier).toHaveCount(1);

    // a message in the main chat (on Codex)
    const typeAndSend = async (text: string) =>
      expect(async () => {
        await box.fill(text);
        await expect(send).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
    await typeAndSend('hello on codex');
    await send.click();
    await expect(chat.getByText(/fake-codex: .*hello on codex/)).toBeVisible({ timeout: 20_000 });

    // Resume: the line goes, in place
    await chat.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(chat.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await expect(identity).toHaveText('Active');

    // MoMo's brain moves to opencode: the same main chat goes on there, with nothing new under Earlier
    await chat.getByRole('button', { name: "MoMo's brain" }).click();
    await page.locator('.hp-harnesses .hp-row', { hasText: 'opencode' }).click();
    await expect(chat.getByRole('button', { name: "MoMo's brain" })).toContainText('opencode', { timeout: 15_000 });
    await expect(chat.getByText(/fake-codex: .*hello on codex/)).toBeVisible();
    await typeAndSend('hello on the new brain');
    await send.click();
    await expect(chat.getByText('Codex → opencode')).toBeVisible({ timeout: 20_000 });
    await expect(chat.getByText(/^fake-acp: /).first()).toBeVisible({ timeout: 20_000 });
    await expect(earlier).toHaveCount(1);

    // the earlier chat opens read-only: the conversation, a note, no composer; the row (not Chat) is the one marked
    await earlier.click();
    await expect(earlier).toHaveAttribute('aria-current', 'page');
    await expect(momoNav(page).getByRole('button', { name: 'Chat', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await expect(chat.getByText('An earlier conversation · Read only')).toBeVisible({ timeout: 15_000 });
    await expect(chat.getByText(/fake-codex: .*remember the first chat/)).toBeVisible();
    await expect(box).toHaveCount(0);

    // Chat goes back to the main chat, which takes a message
    await momoNav(page).getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(momoNav(page).getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(chat.getByText('An earlier conversation · Read only')).toHaveCount(0);
    await expect(box).toBeVisible({ timeout: 15_000 });
    await typeAndSend('one more on opencode');
    await send.click();
    await expect(chat.getByText(/fake-acp: .*one more on opencode/)).toBeVisible({ timeout: 20_000 });
  });
});
