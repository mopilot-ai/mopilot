// MoMo's chat on a basic (ACP) brain, on fakes only (#2279, #2280): moving MoMo's brain to opencode (the fake ACP agent)
// keeps MoMo's main chat, which goes on there from its next message (#2489, after the switch's handoff record) and shows
// none of the coding side's chrome (no Side chat empty state, no "Set by" mode chip, MoMo's own placeholder), and a MoMo
// tool the harness calls under opencode's joined title
// (sage_<nonce>_momo_memory_search) reads as what it did, never as its raw name.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { momoChat, momoSetupDone, openMomo } from './fixtures/momo';

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
const seed = {
  ...momoSetupDone,
  files: ({ home }: { home: string }) => {
    fs.mkdirSync(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api', key: 'test' } }),
    );
  },
};

test.describe('MoMo on a basic harness', () => {
  test.use({ harnesses: 'codex', acp: { opencode: { configOptions: [MODE] } }, seed, env: { MOPILOT_MOMO_DEV: '1' } });

  test('MoMo’s chat moved to opencode: no coding chrome, and its memory search reads “Searched memory”', async ({ page }) => {
    await openMomo(page);
    const chat = momoChat(page);
    await expect(chat.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({ timeout: 15_000 });

    // MoMo's brain to opencode: the same main chat, on it from its next message
    await chat.getByRole('button', { name: "MoMo's brain" }).click();
    await page.locator('.hp-harnesses .hp-row', { hasText: 'opencode' }).click();
    await expect(chat.getByRole('button', { name: "MoMo's brain" })).toContainText('opencode', { timeout: 15_000 });
    const box = chat.getByRole('textbox', { name: 'Message', exact: true });
    await expect(box).toBeVisible();

    // its empty chat is no side chat, and its composer has none of the coding side's chips
    await expect(chat.locator('.side-chat-empty')).toHaveCount(0);
    await expect(chat.getByText('Side chats are temporary', { exact: false })).toHaveCount(0);
    await expect(chat.locator('.perm-btn')).toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'Select model' })).toHaveCount(0);
    await expect(box).toHaveAttribute('data-placeholder', 'Message MoMo');

    // a MoMo tool called under opencode's joined title reads as what it did
    // the new chat may still be starting and reset the composer once: type until the message is there to send
    const send = chat.getByRole('button', { name: 'Send', exact: true });
    await expect(async () => {
      await box.fill('MCPTOOL momo_memory_search {"query":"coffee"}');
      await expect(send).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await send.click();
    // the first message after the switch carries the handoff record before the user's words: the tool's answer is the sign it ran
    await expect(chat.getByText(/\[momo_memory_search: /)).toBeVisible({ timeout: 20_000 });
    // the finished turn's work, unfolded once
    const worked = chat.getByRole('button', { name: /^Worked for/ });
    await worked.waitFor({ state: 'visible' });
    if (!/\bopen\b/.test((await worked.getAttribute('class')) ?? '')) await worked.click();
    const work = chat.locator('.work');
    await expect(work).toBeVisible();
    // One visible step is flat; when thoughts add a group, open its disclosure without assuming its summary text.
    const summary = work.locator('.step-group > .summary > .step-row-hit');
    if (await summary.count()) {
      await expect(summary).toHaveCount(1);
      if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
    }
    await expect(chat.getByRole('button', { name: /^(Searched memory|Couldn’t search memory)$/ })).toBeVisible();
    await expect(chat.locator('.step-text', { hasText: /^(Searched memory|Couldn’t search memory)$/ })).toBeVisible();
    await expect(chat.getByText(/sage_[0-9a-f]{12}/)).toHaveCount(0);
  });
});
