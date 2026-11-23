// Ask MoMo in Quick Chat (#2288), on the fake Claude Code: its view shows MoMo's own state, never the coding side's: MoMo's
// brain in the header instead of Quick Chat's model picker, no "Chat messaging unavailable" line, and a question sent
// from Quick Chat shows in its view at once (main shows a turn's message only to an app window), then MoMo's reply.
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { momoReply } from './fixtures/momo';

async function openMini(app: ElectronApplication, page: Page) {
  await page.evaluate(() => (window as any).native.win.mini());
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('#mini'))).toBe(true);
  return app.windows().find((w) => w.url().endsWith('#mini'))!;
}

test.describe('Ask MoMo in Quick Chat', () => {
  test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' } });

  test('MoMo’s brain, no peer note, and the question sent shows before MoMo’s reply', async ({ page, harness }) => {
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    const mini = await openMini(harness.app, page);
    await expect(mini.getByRole('button', { name: 'Select model' })).toBeVisible();
    await mini.getByRole('button', { name: 'Ask MoMo' }).click();

    // MoMo's state, not the coding Quick Chat's
    await expect(mini.locator('.ask-momo-brain')).toContainText('Claude Code', { timeout: 15_000 });
    await expect(mini.getByRole('button', { name: 'Select model' })).toHaveCount(0);
    await expect(mini.locator('.peer-note')).toHaveCount(0);
    await expect(mini.getByText('Chat messaging unavailable', { exact: false })).toHaveCount(0);

    // the question shows in Quick Chat's view, then MoMo's reply under it
    const question = 'From Quick Chat: what drink do I prefer?';
    await mini.getByRole('textbox', { name: 'Message MoMo' }).fill(question);
    await mini.getByRole('button', { name: 'Send to MoMo' }).click();
    const reply = mini.getByText(momoReply('fake-claude', 'what drink do I prefer?'));
    await expect(reply).toBeVisible({ timeout: 20_000 });
    const asked = mini.getByText(question, { exact: true });
    await expect(asked).toHaveCount(1);
    const [q, r] = await Promise.all([asked.boundingBox(), reply.boundingBox()]);
    expect(q!.y).toBeLessThan(r!.y);
    await expect(mini.locator('.peer-note')).toHaveCount(0);
  });
});
