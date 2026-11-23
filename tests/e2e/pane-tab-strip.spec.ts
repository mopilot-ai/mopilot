// The compact pane strip keeps New tab beside sparse tabs and selection visible through geometry changes.
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures/app';

const CHAT = '019c0000-0000-7000-8000-000000006aa5';

async function selectedVisible(tab: Locator) {
  await expect
    .poll(() =>
      tab.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const viewport = element.closest('.tb-tab-list')!.getBoundingClientRect();
        return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1;
      }),
    )
    .toBe(true);
}

async function renameTab(tab: Locator, title: string) {
  await tab.click({ button: 'right' });
  const page = tab.page();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const input = tab.getByRole('textbox', { name: 'Tab name' });
  await expect(input).toBeFocused();
  await input.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await selectedVisible(input);
  await input.fill(title);
  await input.press('Enter');
}

async function checkNarrowWindowsTab(tab: Locator) {
  const page = tab.page();
  const original = await page.evaluate(() => {
    const root = document.documentElement;
    const saved = { platform: root.dataset.platform, caption: root.style.getPropertyValue('--wco-w') };
    root.dataset.platform = 'win32';
    root.style.setProperty('--wco-w', '138px');
    return saved;
  });
  try {
    const list = page.locator('.tb-tab-list');
    expect(await list.evaluate((element) => element.clientWidth)).toBeLessThan(180);
    await selectedVisible(tab);
    const close = await tab.locator('.tb-tab-close').boundingBox();
    const viewport = await list.boundingBox();
    expect(close!.x + close!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
  } finally {
    await page.evaluate(({ platform, caption }) => {
      const root = document.documentElement;
      if (platform === undefined) delete root.dataset.platform;
      else root.dataset.platform = platform;
      if (caption) root.style.setProperty('--wco-w', caption);
      else root.style.removeProperty('--wco-w');
    }, original);
  }
}

for (const fontSize of [14, 24]) {
  test.describe(`pane tabs at font ${fontSize}`, () => {
    test.use({
      harnesses: 'codex',
      seed: {
        codexThreads: [{ id: CHAT, name: 'A', turns: ['Ready'] }],
        uiState: { prefs: { fontSize, zoomLevel: 0 } },
      },
    });

    test('compact tabs preserve selection and menu anchors through every geometry invalidator', async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1024, height: 682 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const chat = page.locator(`[data-sidebar-chat="${CHAT}"]`);
      await chat.click();
      await expect(page.locator('.tb-title-text')).toHaveText('A');
      await page.locator('.titlebar-right button[aria-label="New tab"]').click();
      const strip = page.locator('.tb-tabs');
      const add = strip.locator(':scope > .tooltip-anchor > button[aria-label="New tab"]');
      const rows = page.locator('.tb-tab-list > .tb-tab');
      const list = page.locator('.tb-tab-list');
      // A percentage in a tab's intrinsic width cap can leave its scroller wider than the rendered tabs.
      for (const [index, title] of [
        'mopilot-linux-feasibility-and-packaging-notes.md',
        'Docs',
        'Another long page title '.repeat(10),
      ].entries()) {
        if (index) await add.click();
        await renameTab(rows.nth(index), title);
        await expect
          .poll(async () => {
            const last = await rows.last().boundingBox();
            const viewport = await list.boundingBox();
            const plus = await add.boundingBox();
            const end = Math.min(last!.x + last!.width, viewport!.x + viewport!.width);
            return Math.abs(plus!.x - end - 4);
          })
          .toBeLessThanOrEqual(1);
        if (!index) {
          await page.screenshot({ path: testInfo.outputPath(`adjacent-new-tab-${fontSize}.png`) });
          await checkNarrowWindowsTab(rows.first());
        }
      }
      for (let n = 3; n < 10; n++) await add.click();
      await expect(rows).toHaveCount(10);
      expect(await list.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      expect(await rows.first().evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(180);
      for (const name of ['New tab', 'Enter full view', 'Hide tabs'])
        await expect(strip.locator(`button[aria-label="${name}"]`)).toBeVisible();

      await renameTab(rows.first(), 'First');
      await renameTab(rows.nth(3), 'Active');
      await renameTab(rows.nth(2), 'Before');
      const active = list.getByRole('button', { name: 'Active', exact: true });
      await active.click();
      await selectedVisible(active);

      // A user's horizontal scroll can leave the active tab behind. The portal menu must keep that position.
      await list.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      const scrollBefore = await list.evaluate((element) => element.scrollLeft);
      await rows.last().click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await menu.evaluate(async (element) => {
        const layer = element.closest('.popover-layer') ?? element;
        await Promise.all(layer.getAnimations({ subtree: true }).map((animation) => animation.finished));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      expect(Math.abs((await list.evaluate((element) => element.scrollLeft)) - scrollBefore)).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // Leave only the preceding tab's close target visible; its exit must not move selection off the left edge.
      await active.click();
      await active.evaluate((element) => {
        const viewport = element.closest('.tb-tab-list')!;
        viewport.scrollLeft += element.getBoundingClientRect().left - viewport.getBoundingClientRect().left - 32;
      });
      const before = list.getByRole('button', { name: 'Before', exact: true });
      const close = before.locator('.tb-tab-close');
      const point = await close.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await expect(close).toBeVisible();
      await page.mouse.click(point.x, point.y);
      await expect(before).toHaveCount(0);
      await selectedVisible(active);

      await renameTab(rows.nth(6), 'Selected');
      const selected = list.getByRole('button', { name: 'Selected', exact: true });
      await selected.click();
      await strip.getByRole('button', { name: 'Enter full view' }).click();
      const back = list.locator('.chat-tab');
      await expect(back).toBeVisible();
      await selected.evaluate((element) => element.scrollIntoView({ block: 'nearest', inline: 'end' }));
      await selectedVisible(selected);
      const oldWidth = await back.evaluate((element) => element.getBoundingClientRect().width);
      await chat.click({ button: 'right' });
      await expect(page.getByRole('menu')).toBeFocused();
      await page.keyboard.press('r');
      const rename = chat.getByRole('textbox');
      const longer = 'A much longer main chat title after the pane was already full';
      await rename.fill(longer);
      await rename.press('Enter');
      await expect(back).toHaveText(longer);
      expect(await back.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(oldWidth);
      await selectedVisible(selected);
      await page.screenshot({ path: testInfo.outputPath(`compact-pane-tabs-${fontSize}.png`) });
    });
  });
}
