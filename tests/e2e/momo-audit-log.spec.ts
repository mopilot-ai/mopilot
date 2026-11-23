// Settings › MoMo › Brain › Audit log (#2290), on fake harnesses only, for an invited account (MOPILOT_MOMO_DEV=1): after a
// read of a Files source is audited, the Audit log group shows its state with Export audit log, and Export writes the log
// as JSONL to the file picked in the (stubbed) save dialog, readable by its owner only.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { twoCodexAccounts } from './fixtures/codexAccounts';
import { goToMomoView, momoChat, openMomo } from './fixtures/momo';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const modDot = process.platform === 'darwin' ? 'Meta+Period' : 'Control+Period';

function journey(harnesses: 'claude' | 'codex') {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    // Codex runs on a signed-in ChatGPT login: the account its audit rows must name
    test.use({
      harnesses,
      env: { MOPILOT_MOMO_DEV: '1' },
      ...(harnesses === 'codex' ? { seed: { files: (d) => twoCodexAccounts(d) } } : {}),
    });

    test('the Audit log group shows, and Export writes the log to the picked file', async ({ page, harness }) => {
      const out = path.join(harness.dir, 'exported audit.jsonl');
      await harness.app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as any;
      }, out);
      await openMomo(page);

      // an audited read: connect Files, then MoMo lists its folders
      const settings = async () => {
        await page.locator('.sidebar-title').first().click();
        await settingsEntry(page).click();
        await page.getByRole('button', { name: 'MoMo', exact: true }).click();
      };
      await settings();
      await page
        .getByRole('tab', { name: 'Sources', exact: true })
        .or(page.getByRole('button', { name: 'Sources', exact: true }))
        .first()
        .click();
      // Add folder connects Files (it needs no macOS grant) and asks main's folder dialog, cancelled here: Files is on with no folders
      await harness.app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      });
      const files = page.getByRole('region', { name: 'Files', exact: true });
      await files.getByRole('button', { name: 'Add folder…' }).click();
      await expect(files.getByText('No folders yet. Add one for MoMo to read.')).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press(modDot);
      await goToMomoView(page, 'Chat');
      const chat = momoChat(page);
      await chat.getByRole('textbox', { name: 'Message', exact: true }).fill(`CUCALL momo_files_list ${JSON.stringify({})}`);
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(chat.getByText(/added no folders to MoMo yet/).last()).toBeVisible({ timeout: 30_000 });

      // Settings › MoMo › Brain › Audit log
      await settings();
      const group = page.locator('section.settings-group', { has: page.getByRole('heading', { name: 'Audit log', exact: true }) });
      await expect(group).toContainText('Every action MoMo took, kept on this Mac.');
      await group.getByRole('button', { name: 'Export audit log' }).click();
      await expect(page.getByText('Saved exported audit.jsonl')).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => fs.existsSync(out)).toBe(true);
      const text = fs.readFileSync(out, 'utf8');
      expect(text.trim().split('\n').length).toBeGreaterThan(0);
      expect(text).toContain('files.list');
      // every entry names the chat's harness and the account it runs on (#2373)
      const rows = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((e) => String(e.action).includes('files.list'));
      expect(rows.length).toBeGreaterThan(0);
      for (const e of rows) {
        expect(e.harness).toBe(harnesses);
        expect(e.account).not.toBe('');
      }
      expect(fs.statSync(out).mode & 0o777).toBe(0o600);
      // a log that checks out is never offered a new one
      await expect(group.getByRole('button', { name: 'Start a new log' })).toHaveCount(0);
    });
  });
}

journey('claude');
journey('codex');
