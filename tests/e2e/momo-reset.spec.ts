// Reset MoMo (#2291, #2307), on fake harnesses only, for an invited account (MOPILOT_MOMO_DEV=1): a fact saved to MoMo's memory
// and an audited read are on disk; Reset (typing "MoMo") leaves <userData>/momo with no memory, chat or audit (and no legacy Feed or Topics files), setup shows
// again and the Reset row says how it ended; right after, without a restart, a Files source connects and its read is audited.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { finishMomoSetup, goToMomoView, meetHeading, momoChat, momoSeed, momoSetupDone, openMomo } from './fixtures/momo';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const modDot = process.platform === 'darwin' ? 'Meta+Period' : 'Control+Period';
const names = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

async function ask(page: Page, text: string, expected: RegExp) {
  const chat = momoChat(page);
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText(expected).last()).toBeVisible({ timeout: 30_000 });
}

function journey(harnesses: 'claude' | 'codex') {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, seed: { ...momoSetupDone, ...momoSeed(harnesses).seed } });

    test('Reset deletes every store; setup shows, the Reset row says so, and a Files source connects and is audited right after', async ({
      page,
      harness,
    }) => {
      const momo = path.join(harness.env.MOPILOT_USER_DATA ?? path.join(harness.dir, 'userData'), 'momo');
      await openMomo(page);
      await goToMomoView(page, 'Chat');

      // files of the removed Feed and Topics, as an older MoPilot left them
      const plantLegacy = () => {
        fs.mkdirSync(path.join(momo, 'topics', 'notes'), { recursive: true });
        fs.writeFileSync(path.join(momo, 'topics', 'topics.json'), '{}');
        fs.writeFileSync(path.join(momo, 'topics', 'notes', 'a.md'), 'old note');
        fs.writeFileSync(path.join(momo, 'feed.json'), '{"posts":[]}');
      };
      plantLegacy();

      // a fact in MoMo's memory, made by MoMo's main chat
      await ask(
        page,
        `CUCALL momo_memory_save ${JSON.stringify({ text: 'The user prefers tea over coffee.', confidence: 'sure' })}`,
        /Saved to MoMo's memory/,
      );
      await expect.poll(() => names(momo).includes('facts.jsonl'), { timeout: 15_000 }).toBe(true);
      expect(fs.existsSync(path.join(momo, 'state.json'))).toBe(true);

      // Settings › MoMo › Brain › Reset MoMo, confirmed by typing MoMo
      await page.locator('.sidebar-title').first().click();
      await settingsEntry(page).click();
      await page.getByRole('button', { name: 'MoMo', exact: true }).click();
      await page.getByRole('button', { name: 'Reset…' }).click();
      await page.getByRole('textbox', { name: 'Type MoMo to confirm' }).fill('MoMo');
      await page.getByRole('button', { name: 'Reset', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'MoMo was reset' })).toBeVisible({ timeout: 30_000 });

      // nothing of MoMo's memory, main chat, audit or legacy Feed and Topics files is left on disk
      const left = names(momo);
      expect(left.filter((n) => /^(about-you\.md|persona\.md|facts\.jsonl)/.test(n))).toEqual([]);
      expect(left).not.toContain('state.json');
      expect(left).not.toContain('workspace');
      expect(left.filter((n) => /^(feed\.json|topics)/.test(n))).toEqual([]);
      expect(names(path.join(momo, 'audit')).filter((n) => /^audit\.(\d{6}\.)?jsonl$/.test(n))).toEqual([]);

      // setup shows again
      await page.keyboard.press(modDot);
      await expect(meetHeading(page)).toBeVisible();
      await finishMomoSetup(page);

      // right after, without a restart: a Files source connects and a read of it is audited
      await page.locator('.sidebar-title').first().click();
      await settingsEntry(page).click();
      await page.getByRole('button', { name: 'MoMo', exact: true }).click();
      await page
        .getByRole('tab', { name: 'Sources', exact: true })
        .or(page.getByRole('button', { name: 'Sources', exact: true }))
        .first()
        .click();
      // Add folder connects Files (it needs no macOS grant) and then asks main's folder dialog; the dialog is cancelled here, so Files is on with no folders
      await harness.app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      });
      const files = page.getByRole('region', { name: 'Files', exact: true });
      await files.getByRole('button', { name: 'Add folder…' }).click();
      await expect(files.getByText('No folders yet. Add one for MoMo to read.')).toBeVisible({ timeout: 15_000 });

      await page.keyboard.press(modDot);
      await goToMomoView(page, 'Chat');
      await ask(page, `CUCALL momo_files_list ${JSON.stringify({})}`, /added no folders to MoMo yet/);
      await expect
        .poll(
          () =>
            names(path.join(momo, 'audit'))
              .filter((n) => /\.jsonl$/.test(n))
              .some((n) => fs.readFileSync(path.join(momo, 'audit', n), 'utf8').includes('files.list')),
          { timeout: 15_000 },
        )
        .toBe(true);
    });
  });
}

journey('claude');
journey('codex');
