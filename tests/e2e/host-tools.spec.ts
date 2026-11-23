// The directory and host tools (request_keep_awake, request_directory, get_storage_usage) from a Codex and a Claude Code chat: the question reaches the user as a card in the chat (hostAsk), Allow and Deny change what the model is told, and
// a read-only tool answers with no card. The fake agents call the tools through the app's own tool channel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const reply = (page: Page, text: RegExp) => page.getByRole('main').getByText(text).first();

// ACP chats share the tool path and are covered by the unit tests (tests/hostToolsWiring.test.ts)
for (const family of ['codex', 'claude'] as const) {
  test.describe(family, () => {
    test.use({ harnesses: family });

    test('a keep-awake request and a folder request ask the user in a card and report the answer; storage needs no card', async ({
      page,
    }) => {
      const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-tools-e2e-')));
      const call = (name: string, args: object) => `CUCALL ${name} ${JSON.stringify(args)}`;
      const send = async (text: string) => {
        await composer(page).fill(text);
        await expect(composer(page)).toHaveText(text);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
      };
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();

      // keep awake: asked once, the card names the reason, Allow holds it
      await send(call('request_keep_awake', { until: 'turn_end', reason: 'Waiting for CI.' }));
      const card = page.locator('.approval-card[data-kind="hostAsk"]');
      await expect(card.locator('.approval-kind')).toHaveText('Keep awake');
      await expect(card).toContainText('Waiting for CI.');
      await page.screenshot({ path: test.info().outputPath(`${family}-keep-awake-card.png`) });
      await card.getByRole('button', { name: /^Allow/ }).click();
      await expect(reply(page, /Keeping this computer awake until this turn finishes/)).toBeVisible({ timeout: 30_000 });
      await expect(card).toHaveCount(0);

      // a folder: Deny grants nothing and tells the model not to ask again
      await send(call('request_directory', { path: folder }));
      await expect(card.locator('.approval-kind')).toHaveText('Folder access');
      await expect(card).toContainText(folder);
      await card.getByRole('button', { name: /^Deny/ }).click();
      await expect(reply(page, /declined to give access to that folder/)).toBeVisible({ timeout: 30_000 });

      // asked again, Allow grants it
      await send(call('request_directory', { path: folder }));
      await card.getByRole('button', { name: /^Allow/ }).click();
      await expect(reply(page, new RegExp(`Folder access granted: ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeVisible({
        timeout: 30_000,
      });

      // storage: read-only, no card
      await send(call('get_storage_usage', {}));
      await expect(reply(page, /"worktrees"/)).toBeVisible({ timeout: 30_000 });
      await expect(card).toHaveCount(0);
    });
  });
}
