// MoMo's page shell (M0b, `momo.shell`), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1), clicking every control of it in the real renderer: the rail (Everything, no channels or Sessions, where MoMo runs), its toggle (hide completely, show again), the Tasks and Files buttons (each opens its 420 pt panel, switching replaces it so there are never two, the same button closes it, so do Close and Esc, and an Esc that is not the panel's leaves it), and replies that arrive whole: while a turn runs the chat says "Thinking it through" and draws no part of the reply, then one complete bubble appears (and with prefers-reduced-motion it appears with no animation). With the flag off the page is today's chat with none of it. Runs the same on Linux and macOS.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { momoChat, momoChatSession, openMomo } from './fixtures/momo';

const prefs = (momo: Record<string, unknown>) => ({
  files: (d: Parameters<typeof codexCliLogin>[0]) => codexCliLogin(d),
  uiState: { prefs: { momo: { routines: { proactivity: 'default', quietHours: null }, ...momo } } },
});

/** MoMo greets when it is first opened: wait until that turn is over, so the next message starts its own turn instead of queuing behind it. */
async function greeted(chat: ReturnType<typeof momoChat>) {
  await expect(chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 60_000 });
  await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
}

/** The shell's own controls, scoped to it: the sidebar column has a Tasks button of its own. */
const parts = (page: Page) => {
  const shell = page.locator('[data-momo-shell]');
  return {
    shell,
    rail: shell.getByRole('navigation', { name: 'MoMo' }),
    tasksButton: shell.getByRole('button', { name: 'Tasks', exact: true }),
    filesButton: shell.getByRole('button', { name: 'Files', exact: true }),
    tasks: shell.getByRole('region', { name: 'Tasks', exact: true }),
    files: shell.getByRole('region', { name: 'Files', exact: true }),
  };
};

test.describe('shell on', () => {
  test.use({
    harnesses: 'claude',
    env: { MOPILOT_MOMO_DEV: '1' },
    seed: prefs({ shell: true, tasksPanel: true }),
  });

  test('the rail and its toggle: Everything, where MoMo runs, no channels or Sessions; hide completely and show again', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openMomo(page);
    const { chat } = await momoChatSession(page);
    const { shell, rail } = parts(page);
    await expect(shell).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Everything', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(rail.getByText('Runs on this Mac')).toBeVisible();
    await expect(shell.getByRole('button', { name: 'New channel' })).toHaveCount(0);
    await expect(shell.getByRole('button', { name: 'Sessions', exact: true })).toHaveCount(0);
    await expect(chat.getByText('MoMo can make mistakes.')).toBeVisible();
    // Everything is the main chat: clicking it leaves the page where it is
    await rail.getByRole('button', { name: 'Everything', exact: true }).click();
    await expect(chat).toBeVisible();
    // the toggle hides the rail completely, with no icon rail left, and brings it back
    await rail.getByRole('button', { name: 'Hide sidebar' }).click();
    await expect(rail).toHaveCount(0);
    await expect(shell.getByRole('button', { name: 'Hide sidebar' })).toHaveCount(0);
    await expect(chat).toBeVisible();
    await shell.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(rail).toBeVisible();
    await expect(shell.getByRole('button', { name: 'Show sidebar' })).toHaveCount(0);
  });

  test('the panels: Tasks, Files, switching, the same button, Close and Esc, never two at once', async ({ page }) => {
    test.setTimeout(120_000);
    await openMomo(page);
    await momoChatSession(page);
    const { shell, tasksButton, filesButton, tasks, files } = parts(page);
    const none = async () => {
      await expect(tasks).toHaveCount(0);
      await expect(files).toHaveCount(0);
    };
    await none();
    await expect(tasksButton).toHaveAttribute('aria-pressed', 'false');

    // Tasks opens its panel: 420 pt wide, with its tabs
    await tasksButton.click();
    await expect(tasks.getByRole('tablist', { name: 'Tasks' })).toBeVisible({ timeout: 30_000 });
    await expect(tasks).toHaveCSS('width', '420px');
    await expect(tasksButton).toHaveAttribute('aria-pressed', 'true');
    await expect(shell.locator('aside')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('momo-shell-tasks.png') });

    // Files replaces it: one panel at a time
    await filesButton.click();
    await expect(files).toBeVisible();
    await expect(files).toHaveCSS('width', '420px');
    await expect(tasks).toHaveCount(0);
    await expect(shell.locator('aside')).toHaveCount(1);
    await expect(filesButton).toHaveAttribute('aria-pressed', 'true');
    await expect(tasksButton).toHaveAttribute('aria-pressed', 'false');
    await page.screenshot({ path: test.info().outputPath('momo-shell-files.png') });

    // and back to Tasks
    await tasksButton.click();
    await expect(tasks).toBeVisible();
    await expect(files).toHaveCount(0);

    // the same button closes it, in one frame (no animation: it is gone at once)
    await tasksButton.click();
    await none();

    // Close closes it
    await filesButton.click();
    await expect(files).toBeVisible();
    await files.getByRole('button', { name: 'Close', exact: true }).click();
    await none();

    // Esc closes it, and a key that is not Esc leaves it
    await tasksButton.click();
    await expect(tasks).toBeVisible();
    await page.keyboard.press('a');
    await expect(tasks).toBeVisible();
    await page.keyboard.press('Escape');
    await none();
    await filesButton.click();
    await expect(files).toBeVisible();
    await page.keyboard.press('Escape');
    await none();
  });

  test('replies arrive whole: Thinking it through and no part of the reply while MoMo works, then one complete bubble', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openMomo(page);
    const { chat, send } = await momoChatSession(page);
    await greeted(chat);
    // SLOW makes the fake stream its echo and wait for Stop: the stream is not drawn, the pill says what is going on
    await send('SLOW please');
    await expect(chat.getByText('Thinking it through')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    await expect(chat.getByText(/fake-claude: SLOW/)).toHaveCount(0);
    await chat.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(chat.getByText('Thinking it through')).toHaveCount(0, { timeout: 30_000 });
    // a normal turn: the whole reply appears, the pill goes, and the bubble arrives with the motion token's animation
    await send('Say hello');
    const reply = chat.locator('.assistant-message', { hasText: /fake-claude: / }).first();
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByText('Thinking it through')).toHaveCount(0, { timeout: 30_000 });
    const animation = await reply.evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).not.toBe('none');
  });

  test('with prefers-reduced-motion the whole reply appears with no animation, and the pill still says what is going on', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openMomo(page);
    const { chat, send } = await momoChatSession(page);
    await greeted(chat);
    await send('SLOW please');
    await expect(chat.getByText('Thinking it through')).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByText(/fake-claude: SLOW/)).toHaveCount(0);
    await chat.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(chat.getByText('Thinking it through')).toHaveCount(0, { timeout: 30_000 });
    await send('Say hello');
    const reply = chat.locator('.assistant-message', { hasText: /fake-claude: / }).first();
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(reply).toHaveCSS('animation-name', 'none');
  });
});

test.describe('shell off', () => {
  test.use({
    harnesses: 'claude',
    env: { MOPILOT_MOMO_DEV: '1' },
    seed: prefs({ tasksPanel: true }),
  });

  test('the page is today’s chat: no rail, no panel buttons, no footer line, no pill, and a reply still streams', async ({ page }) => {
    test.setTimeout(120_000);
    await openMomo(page);
    const { send } = await momoChatSession(page);
    await greeted(momoChat(page));
    await expect(page.locator('[data-momo-shell]')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'MoMo' })).toHaveCount(0);
    await expect(momoChat(page).getByText('MoMo can make mistakes.')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Tasks', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Files', exact: true })).toHaveCount(0);
    // the chat is the page itself, as it was
    await expect(momoChat(page).locator('[data-arrive]')).toHaveCount(0);
    await send('SLOW please');
    // the stream shows as it arrives, with no pill
    await expect(momoChat(page).getByText(/fake-claude: SLOW/)).toBeVisible({ timeout: 30_000 });
    await expect(momoChat(page).getByText('Thinking it through')).toHaveCount(0);
    await momoChat(page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(momoChat(page).getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
    await send('Say hello');
    await expect(
      momoChat(page)
        .getByText(/fake-claude: /)
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(momoChat(page).locator('[data-arrive]')).toHaveCount(0);
  });
});
