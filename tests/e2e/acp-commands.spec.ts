// A basic harness's modes, config options and command catalog, in the real app. With no catalog a
// typed /xxx goes out as typed; once one is pushed, an unlisted /xxx offers "Send as plain text". A new chat shows
// what the harness offers before its session opens and starts on what was chosen there.
// e2e-covers: src/components/composer/Composer.tsx
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { standaloneNewChat } from './fixtures/sidebar';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const opencodePresets = JSON.parse(require('../../electron/harness/quirks/opencode.cjs').env.OPENCODE_CONFIG_CONTENT).agent;

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function newChatOn(page: Page, label: string) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await page.getByRole('button', { name: /^Select (model|harness)$/ }).click();
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  if (await toList.isVisible().catch(() => false)) await toList.click();
  await page.locator('.hp-harnesses .hp-row', { hasText: label }).click();
  await expect(page.getByRole('button', { name: 'Select model' })).toHaveAttribute('title', new RegExp(label));
}

test.use({
  harnesses: 'codex',
  acp: {
    kimi: {
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'fast', name: 'Fast one' },
            { value: 'smart', name: 'Smart one' },
          ],
        },
      ],
      commands: [
        { name: 'goal', description: 'Set a goal and keep going' },
        { name: 'init', description: 'Write AGENTS.md' },
      ],
      usage: true,
    },
    // its quirks mark the mode `plan` as plan mode
    qwen: {
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    },
    // pushes no command catalog, no modes
    goose: {},
    // opencode's shape: its modes are a config option of category "mode"; its quirks map three onto permission rows
    opencode: {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'fast', name: 'Fast one' },
            { value: 'smart', name: 'Smart one' },
          ],
        },
        {
          id: 'mode',
          name: 'Session Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'build',
          options: ['build', 'mopilot-ask', 'mopilot-full', 'plan'].map((value) => ({
            value,
            name: value,
            description: opencodePresets[value]?.description,
          })),
        },
      ],
    },
  },
});

test('no catalog: /xxx goes out as typed, and the harness sets permissions', async ({ page }) => {
  await newChatOn(page, 'Goose');
  await send(page, '/whatever raw');
  await expect(transcript(page).getByText('fake-acp: /whatever raw', { exact: true })).toBeVisible();
  await expect(page.locator('.perm-btn.set-by')).toHaveText('');
  await expect(page.locator('.perm-btn.set-by')).toHaveAttribute('aria-description', /Goose/);
});

test('modes, config options and the command catalog', async ({ page }) => {
  await newChatOn(page, 'Kimi Code');
  await send(page, 'hello');
  await expect(transcript(page).getByText('fake-acp: hello', { exact: true })).toBeVisible();

  // modes its quirks don't name as its own: in the permission slot, by their own names (#1875)
  await page.getByRole('button', { name: 'Change permissions' }).click();
  await page.locator('.perm-menu .menu-item', { hasText: 'Plan' }).click();
  await expect(page.getByRole('button', { name: 'Change permissions' })).toHaveText('Plan');
  // config options from the harness
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Fast one');
  await page.getByRole('button', { name: 'Select model' }).click();
  await page.locator('.acp-config .menu-item', { hasText: 'Smart one' }).click();
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Smart one');
  await send(page, 'SETTINGS');
  await expect(transcript(page).getByText('[mode: plan config: {"model":"smart"}]')).toBeVisible();

  // a listed command passes through
  await send(page, '/goal ship it');
  await expect(transcript(page).getByText('ran /goal', { exact: true })).toBeVisible();
  // the / menu lists the harness's commands
  await composer(page).fill('/in');
  await expect(page.locator('.slash-panel')).toContainText('/init');
  await page.keyboard.press('Escape');
  // an unlisted one asks first
  await send(page, '/nope x');
  await expect(page.locator('.slash-note')).toContainText("Kimi Code doesn't list /nope");
  await expect(transcript(page).getByText('fake-acp: /nope x', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send as plain text' }).click();
  await expect(transcript(page).getByText('fake-acp: /nope x', { exact: true })).toBeVisible();
});

test('the Plan chip follows the mode the quirks mark as plan', async ({ page }) => {
  await newChatOn(page, 'Qwen Code');
  await send(page, 'hello');
  await expect(transcript(page).getByText('fake-acp: hello', { exact: true })).toBeVisible();
  await expect(page.locator('.plan-chip')).toHaveCount(0);
  await page.getByRole('button', { name: 'Change permissions' }).click();
  await page.locator('.perm-menu .menu-item', { hasText: 'Plan' }).click();
  await expect(page.locator('.plan-chip')).toBeVisible();
  await page.getByRole('button', { name: 'Change permissions' }).click();
  await page.locator('.perm-menu .menu-item', { hasText: 'Default' }).click();
  await expect(page.locator('.plan-chip')).toHaveCount(0);
});

test('a new chat starts on the mode and model chosen before its first message, and they are the next default', async ({ page }) => {
  await newChatOn(page, 'opencode');
  // before any session: what the harness offered when it was admitted
  // One trigger represents the single native mode; every permission and agent choice is in its menu.
  await expect(page.getByRole('button', { name: 'Change permissions' })).toHaveText('Build');
  await page.getByRole('button', { name: 'Change permissions' }).click();
  await expect(page.locator('.perm-menu .menu-title')).toHaveText(['Read-only', 'Ask for approval', 'Full access', 'Build']);
  await page.locator('.perm-menu .menu-item', { hasText: 'Ask for approval' }).click();
  await expect(page.getByRole('button', { name: 'Change permissions' })).toHaveText('Ask for approval');
  await expect(page.getByRole('button', { name: 'Change mode' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select model' }).click();
  await expect(page.locator('.acp-config .hp-head')).toHaveText(['Model', 'Harness']);
  await page.locator('.acp-config .menu-item', { hasText: 'Smart one' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Smart one');
  await send(page, 'SETTINGS');
  await expect(transcript(page).getByText('[mode: null config: {"model":"smart","mode":"mopilot-ask"}]')).toBeVisible();
  // the next new chat starts on them too
  await newChatOn(page, 'opencode');
  await expect(page.getByRole('button', { name: 'Change permissions' })).toHaveText('Ask for approval');
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Smart one');
});

test.describe('permission preset presentation', () => {
  test.use({ seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } } });

  test('explains native mode ownership and offers readable presets in a narrow window', async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 682 });
    await newChatOn(page, 'opencode');
    const permission = page.getByRole('button', { name: 'Change permissions' });
    await expect(permission).toHaveText('Build');
    await permission.click();
    const menu = page.locator('.acp-perm-menu');
    await expect(menu.locator('.perm-mode-note')).toHaveText(
      'Build runs under opencode’s own permission settings. Choosing a permission preset switches modes.',
    );
    await expect(menu).not.toContainText(/mopilot-(ask|full)/);
    await expect(menu.locator('.menu-desc')).toHaveText([
      opencodePresets['mopilot-ask'].description,
      opencodePresets['mopilot-full'].description,
    ]);
    for (const desc of await menu.locator('.menu-desc').all()) {
      await expect.poll(() => desc.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    }
    await expect(menu.locator('.menu-title')).toHaveText(['Read-only', 'Ask for approval', 'Full access', 'Build']);
    for (const row of await menu.locator('.perm-item').all()) {
      await expect
        .poll(() =>
          row.evaluate((el) => {
            const title = el.querySelector('.menu-title')!;
            const titleCenter = title.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(title).lineHeight) / 2;
            return ['.menu-icon', '.menu-check'].every((selector) => {
              const rect = el.querySelector(selector)!.getBoundingClientRect();
              return Math.abs(rect.top + rect.height / 2 - titleCenter) < 2;
            });
          }),
        )
        .toBe(true);
    }
    await expect
      .poll(() =>
        menu.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth;
        }),
      )
      .toBe(true);
    await page.screenshot({ path: info.outputPath('acp-permissions-narrow-large-font.png'), animations: 'disabled' });
    await menu.locator('.perm-item.full-access').click();
    await expect(permission).toHaveText('Full access');
    await permission.click();
    await expect(menu.locator('.perm-mode-note')).toHaveCount(0);
    await menu.locator('.perm-item.read-only').click();
    await expect(permission).toHaveText('Read-only');
    await permission.click();
    await menu.locator('.menu-item', { hasText: 'Build' }).click();
    await expect(permission).toHaveText('Build');
    await permission.click();
    await expect(menu.locator('.perm-mode-note')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
