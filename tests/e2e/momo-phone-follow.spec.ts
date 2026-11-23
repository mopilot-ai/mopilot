// A paired phone opening MoMo, against the real main process on a fake harness: momo.chat.follow reads the main chat the Mac's MoMo page wrote to (it failed with "That chat isn't in MoPilot." while the snapshot read went through the coding side's guard), and chat.follow still refuses that chat.
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { momoChat, momoReply, momoSeed, momoSetupDone, openMomo } from './fixtures/momo';

test.use({
  harnesses: 'codex',
  env: { MOPILOT_MOMO_DEV: '1' },
  mainRequire: [path.join(__dirname, 'fixtures', 'remote-service-hook.cjs')],
  // setup already done: no greeting turn, so the message below is sent at once rather than queued behind it
  seed: { ...momoSeed('codex').seed, ...momoSetupDone },
});

test('a phone follows MoMo’s main chat and sees its messages; the coding side’s follow is still refused', async ({ page, harness }) => {
  await openMomo(page);
  const chat = momoChat(page);
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('hello from the Mac');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText(momoReply('fake-codex', 'hello from the Mac'))).toBeVisible({ timeout: 20_000 });

  const ask = () =>
    harness.app.evaluate(async () => {
      const service = (globalThis as any).__remoteService;
      const client = { kind: 'phone', pairId: 'phone-e2e', follows: new Set<string>() };
      const followed = await service.call(client, 'momo.chat.follow', { items: 50 });
      const refused = await service.call(client, 'chat.follow', { chatId: followed.chatId, items: 5 }).then(
        () => null,
        (error: Error) => error.message,
      );
      return { chatId: followed.chatId, followed: client.follows.has(followed.chatId), items: JSON.stringify(followed.items), refused };
    });
  // the harness writes its history a moment after the Mac's page shows the reply
  await expect.poll(async () => (await ask()).items, { timeout: 15_000 }).toContain('hello from the Mac');
  const result = await ask();
  expect(result.chatId).toBeTruthy();
  expect(result.followed).toBe(true);
  expect(result.refused).toBe("That chat isn't in MoPilot.");
});
