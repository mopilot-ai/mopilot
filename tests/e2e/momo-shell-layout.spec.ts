// MoMo's shell layout (#4926, design 5.1) on a fake harness for an invited account (MOPILOT_MOMO_DEV=1) with `momo.shell`, `momo.channels` and `momo.tasksPanel` on: the rail is the page's ONE navigation column (no second MoMo nav beside it), its width is dragged and keyed with the app sidebar's own handle and kept across a reload, "New channel or group" is one action row that opens a menu, the thread draws only MoMo's words (no stub reply, no duration on a stop), and screenshots of the page at 900, 1280 and 1680 pt, light and dark, with no, one and several channels are saved as test artifacts. No Mac-only API: it runs on Linux and macOS.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { momoChat, momoChatSession, momoNav, openMomo } from './fixtures/momo';

// The design's window widths
const WIDTHS = [1440, 1100, 800];
const shell = (page: Page) => page.locator('[data-momo-shell]');
const rail = (page: Page) => shell(page).getByRole('navigation', { name: 'MoMo' });
const handle = (page: Page) => shell(page).getByRole('separator', { name: 'Resize sidebar', exact: true });

/** Makes a channel through the rail's one New row and waits for its chat. */
async function makeChannel(page: Page, name: string) {
  await rail(page).getByRole('button', { name: 'New channel or group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
  const dialog = page.locator('.dialog');
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: name, exact: true })).toHaveAttribute('aria-current', 'page', {
    timeout: 30_000,
  });
}

/** The rail's width in pixels as the page draws it. */
const railWidth = async (page: Page) => Math.round((await rail(page).boundingBox())!.width);

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme}`, () => {
    test.use({
      harnesses: 'claude',
      env: { MOPILOT_MOMO_DEV: '1' },
      seed: {
        files: (d) => codexCliLogin(d),
        uiState: {
          prefs: { theme, momo: { shell: true, channels: true, tasksPanel: true, routines: { proactivity: 'default', quietHours: null } } },
        },
      },
    });

    test(`${theme}: one navigation column, a draggable rail, actions as actions, and the shell at three widths with zero, one and several channels`, async ({
      page,
    }) => {
      test.setTimeout(300_000);
      const shot = async (name: string) => {
        // no hover in the picture: the pointer leaves the rail first
        await page.mouse.move(2, 2);
        // hover states have eased out before the picture
        await page.waitForTimeout(300);
        const path = test.info().outputPath(`${name}.png`);
        await page.screenshot({ path });
        await test.info().attach(name, { path, contentType: 'image/png' });
      };
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);

      // ONE navigation column: the rail; the app's MoMo nav is not drawn beside it
      await expect(rail(page)).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'MoMo' })).toHaveCount(0);
      await expect(rail(page).getByRole('button', { name: 'Back to chats' })).toBeVisible();
      await expect(rail(page).getByRole('button', { name: 'Memory', exact: true })).toBeVisible();
      await expect(rail(page).getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
      await expect(momoNav(page)).toHaveCount(1);

      // the default rail is the design's 288 wide at 1440 (every picture below is shot at the default; the resize checks come last)
      await page.setViewportSize({ width: 1440, height: 860 });
      await expect(handle(page)).toBeVisible();
      await expect(handle(page)).toHaveCSS('cursor', 'col-resize');
      expect(Math.abs((await railWidth(page)) - 288), 'the default rail is 288 wide').toBeLessThanOrEqual(2);

      // Cmd (Ctrl elsewhere) + B hides and shows the rail, and the choice is kept
      const toggle = process.platform === 'darwin' ? 'Meta+b' : 'Control+b';
      await page.keyboard.press(toggle);
      await expect(rail(page)).toHaveCount(0);
      await page.keyboard.press(toggle);
      await expect(rail(page)).toBeVisible();

      // the New row is an action, not a place, and opens a menu of the two
      const add = rail(page).getByRole('button', { name: 'New channel or group', exact: true });
      await expect(add).not.toHaveAttribute('aria-current', /.+/);
      await add.click();
      await expect(page.getByRole('menuitem')).toHaveText(['New channel', 'New group']);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);

      // the thread: after a message there is only MoMo's reply, no stub text and no duration on a stop
      await send('Hello MoMo');
      await expect(chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 60_000 });
      await expect(chat.getByText('No response requested.')).toHaveCount(0);
      await expect(chat.getByText(/Stopped after/)).toHaveCount(0);
      await expect(chat.getByText('Plan from before your last message')).toHaveCount(0);

      // a reply that is the CLI's own stub record is no reply of MoMo's: the message shows, the stub does not
      await send('STUBREPLY one');
      await expect(chat.getByText('STUBREPLY one').first()).toBeVisible({ timeout: 30_000 });
      await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
      await expect(chat.getByText('No response requested.')).toHaveCount(0);

      // the side pane has its own separator and opens in one frame; the rail hides at once and the centre eases over about 200 ms
      await shell(page).getByRole('button', { name: 'Tasks', exact: true }).click();
      const pane = shell(page).getByRole('region', { name: 'Tasks', exact: true });
      await expect(pane.getByRole('separator', { name: 'Resize side pane' })).toHaveAttribute('aria-valuenow', '420');
      await shot(`shell-${theme}-pane-1440`);
      await shell(page).getByRole('button', { name: 'Tasks', exact: true }).click();
      await expect(pane).toHaveCount(0);
      const strip = await page.evaluate(
        () =>
          new Promise<{ t: number; padding: number; rail: boolean }[]>((resolve) => {
            const centre = document.querySelector('[data-momo-shell] [data-rail]') as HTMLElement;
            const hide = document.querySelector('[data-momo-shell] nav [aria-label="Hide sidebar"]') as HTMLElement;
            const out: { t: number; padding: number; rail: boolean }[] = [];
            const start = performance.now();
            hide.click();
            const tick = () => {
              const t = performance.now() - start;
              out.push({
                t: Math.round(t),
                padding: Math.round(Number.parseFloat(getComputedStyle(centre).paddingLeft)),
                rail: !!document.querySelector('[data-momo-shell] nav'),
              });
              if (t < 420) requestAnimationFrame(tick);
              else resolve(out);
            };
            requestAnimationFrame(tick);
          }),
      );
      await test.info().attach(`padding-strip-${theme}.json`, { body: JSON.stringify(strip, null, 1), contentType: 'application/json' });
      expect(strip.find((f) => !f.rail)!.t, 'the rail itself is gone within a few frames').toBeLessThan(100);
      expect(Math.max(...strip.map((f) => f.padding)), 'the centre starts where the rail was').toBeGreaterThan(100);
      expect(strip.at(-1)!.padding).toBe(0);
      const settled = strip.find((f, i) => f.padding === 0 && i > 0)!.t;
      expect(settled, 'eased over about 200 ms').toBeGreaterThan(100);
      expect(settled).toBeLessThan(500);
      await shell(page).getByRole('button', { name: 'Show sidebar' }).click();
      await expect(rail(page)).toBeVisible();

      const sweep = async (label: string, current: string) => {
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 860 });
          await expect(rail(page)).toBeVisible();
          await page.mouse.move(2, 2);
          // the highlighted row is the open place, and only that one
          await expect(rail(page).locator('[aria-current=page]')).toHaveText(current);
          await expect(rail(page).locator('[aria-current=page]')).toHaveCount(1);
          // ONE back arrow, in the rail's header
          await expect(page.getByRole('button', { name: /^Back to/ })).toHaveCount(1);
          // the thread is above the composer and the composer is at the bottom of the window
          const composer = (await momoChat(page).getByRole('textbox', { name: 'Message', exact: true }).boundingBox())!;
          expect(composer.y + composer.height, `composer at the bottom at ${width}`).toBeGreaterThan(860 - 200);
          const welcome = page.locator('[data-welcome]');
          if (await welcome.count()) {
            const w = (await welcome.boundingBox())!;
            expect(w.y + w.height, 'the first row is above the composer').toBeLessThanOrEqual(composer.y);
          }
          if (current !== 'Main') await expect(page.locator('[data-channel-header]')).toHaveText(current);
          await shot(`shell-${theme}-${label}-${width}`);
        }
      };
      await sweep('no-channels', 'Main');
      await makeChannel(page, 'Trip');
      await sweep('one-channel', 'Trip');
      for (const name of ['Garden', 'Kitchen', 'Reading']) await makeChannel(page, name);
      await sweep('several-channels', 'Reading');
      // Space picks a channel up, Up moves it one place, Space drops it: the order is main's, so it holds
      const order = () => rail(page).locator('li > button').allTextContents();
      const reading = rail(page).getByRole('button', { name: 'Reading', exact: true });
      await reading.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Space');
      await expect
        .poll(async () => (await order()).filter((n) => ['Garden', 'Kitchen', 'Reading'].includes(n)))
        .toEqual(['Garden', 'Reading', 'Kitchen']);
      // the Memory page sits in the same shell, with the same rail
      await rail(page).getByRole('button', { name: 'Memory', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Memory', level: 1, exact: true })).toBeVisible();
      await expect(rail(page)).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'MoMo' })).toHaveCount(0);
      await shot(`shell-${theme}-memory-1440`);
      await expect(momoChat(page)).toHaveCount(0);

      // the rail's handle is the app sidebar's own: same strip, cursor and keys; the width is kept
      await page.setViewportSize({ width: 1440, height: 860 });
      await expect(handle(page)).toBeVisible();
      await expect(handle(page)).toHaveCSS('cursor', 'col-resize');
      const start = await railWidth(page);
      await handle(page).focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => railWidth(page)).toBeGreaterThan(start);
      const box = (await handle(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + 200, { steps: 4 });
      await page.mouse.up();
      const dragged = await railWidth(page);
      expect(dragged).toBeGreaterThan(start + 10);
      // a restart: the window loads again and MoMo is opened again
      await page.reload();
      await openMomo(page);
      await expect(rail(page)).toBeVisible({ timeout: 30_000 });
      expect(Math.abs((await railWidth(page)) - dragged)).toBeLessThanOrEqual(1);
    });
  });
}
