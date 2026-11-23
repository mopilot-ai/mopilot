// The bottom terminal panel runs a local pty (electron/platform/pty.cjs), with or without Codex.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function terminalJourney(harness: Harness) {
  const { app, page, dir } = harness;
  // An empty HOME would make zsh start its first-run setup menu instead of a prompt.
  for (const f of ['.zshrc', '.bashrc', '.bash_profile']) fs.writeFileSync(path.join(dir, 'home', f), '');
  // Not the home view: without Codex the main view still waits on its connection (WP2 app gating).
  await expect(page.getByRole('button', { name: 'Toggle sidebar' })).toBeVisible();

  // View → Open Terminal, as the menu (⌃`) does it
  await app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === 'Open Terminal') return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
  const panel = page.locator('.bottom-panel');
  await expect(panel.locator('.bottom-tab')).toHaveCount(1);
  const rows = panel.locator('.xterm-rows > div');

  await panel.locator('.term-view').click();
  // the shell's own pid: $$ in sh and zsh, $PID in PowerShell (the Windows terminal, src/lib/platform.ts defaultShell)
  await page.keyboard.type(process.platform === 'win32' ? 'echo sage-pty-ok; echo "pid=$PID"' : 'echo sage-pty-ok; echo pid=$$');
  await page.keyboard.press('Enter');
  await expect(rows.filter({ hasText: /^\s*sage-pty-ok\s*$/ })).toHaveCount(1);
  const pidRow = rows.filter({ hasText: /^\s*pid=\d+\s*$/ });
  await expect(pidRow).toHaveCount(1);
  const pid = Number((await pidRow.textContent())!.trim().slice(4));
  expect(alive(pid)).toBe(true);

  // closing the last tab hides the panel and ends the shell
  await panel.locator('.bottom-tab button').click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => alive(pid)).toBe(false);
}

test('terminal: runs a command in a local shell and closes', async ({ harness }) => {
  await terminalJourney(harness);
});

test.describe('Claude only (no Codex)', () => {
  test.use({ harnesses: 'claude' });
  test('terminal: runs a command in a local shell and closes', async ({ harness }) => {
    await terminalJourney(harness);
  });
});
