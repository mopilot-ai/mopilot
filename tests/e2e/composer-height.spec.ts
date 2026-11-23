// Empty chat composers keep aligned heights across unequal pane widths, font sizes and harness families.
// e2e-covers: src/components/composer/ContextRing.tsx src/styles/app/composer.css
import { test, expect } from './fixtures/app';
import { sizeViewport } from './fixtures/window';
import { controlsAreSeparate } from '../support/layoutBounds';
import type { Page } from '@playwright/test';

/** Each saved chat restores its own Summary pane; close it so two chat columns have room. */
async function closeSummary(page: Page) {
  const toggle = page.getByRole('button', { name: 'Summary', exact: true });
  if ((await toggle.getAttribute('class'))?.split(' ').includes('active')) await toggle.click();
  await expect(toggle).not.toHaveClass(/\bactive\b/);
  await expect.poll(async () => (await page.locator('.split-frame').boundingBox())?.width ?? 0).toBeGreaterThan(720);
}

async function measureComposer(page: Page, width: number) {
  await page.locator('.composer-wrap').evaluate((el, width) => {
    (el as HTMLElement).style.width = `${width}px`;
  }, width);
  const geometry = await page.locator('.composer').evaluate((composer) => {
    const bounds = composer.getBoundingClientRect();
    const model = composer.querySelector('.model-btn')!.getBoundingClientRect();
    const context = composer.querySelector('.context-ring')!.getBoundingClientRect();
    const controls = [...composer.querySelectorAll('.composer-footer button')]
      .map((button) => button.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    const row = controls[0];
    return {
      height: bounds.height,
      contextAfterModel: context.left >= model.right,
      glyphsFit: [...composer.querySelectorAll('.model-btn > svg')]
        .filter((glyph) => getComputedStyle(glyph).display !== 'none')
        .every((glyph) => {
          const icon = glyph.getBoundingClientRect(),
            button = glyph.parentElement!.getBoundingClientRect();
          return icon.left >= button.left && icon.right <= button.right;
        }),
      controls: controls.map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
      fit: controls.every((box) => box.left >= bounds.left && box.right <= bounds.right),
      sameRow: controls.every((box) => Math.abs((box.top + box.bottom - row.top - row.bottom) / 2) <= 0.5),
    };
  });
  expect(geometry.fit, `controls fit at ${width}px`).toBe(true);
  expect(geometry.contextAfterModel, `context ring follows model at ${width}px`).toBe(true);
  expect(geometry.sameRow, `one toolbar row at ${width}px`).toBe(true);
  expect(geometry.glyphsFit, `model glyphs fit at ${width}px`).toBe(true);
  expect(controlsAreSeparate(geometry.controls), `separate click targets at ${width}px`).toBe(true);
  return geometry.height;
}

for (const fontSize of [14, 24]) {
  for (const family of [
    { label: 'Codex', harnesses: 'codex', acp: {}, defaultHarness: 'codex' },
    { label: 'Claude Code', harnesses: 'claude', acp: {}, defaultHarness: 'claude' },
    {
      label: 'ACP',
      harnesses: 'none',
      acp: {
        opencode: {
          usage: true,
          commands: [{ name: 'goal', description: 'Set a goal' }],
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'provider/long',
              options: [{ value: 'provider/long', name: 'Provider/A very long custom model name with release information' }],
            },
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              type: 'select',
              currentValue: 'mopilot-full',
              options: [
                { value: 'mopilot-full', name: 'mopilot-full' },
                { value: 'plan', name: 'plan' },
              ],
            },
          ],
        },
      },
      defaultHarness: 'acp:opencode',
    },
  ] as const) {
    test.describe(`${family.label} composer at ${fontSize}px`, () => {
      if (family.label === 'ACP') test.skip(process.platform !== 'darwin', 'ACP admission requires the macOS bridge');
      test.use({
        harnesses: family.harnesses,
        acp: family.acp,
        seed: { uiState: { summaryOpen: false, prefs: { defaultHarness: family.defaultHarness, fontSize, zoomLevel: 0 } } },
      });

      test('narrowing and widening preserve height and reachable controls', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1024, height: 682 });
        const input = page.getByRole('textbox', { name: 'Message', exact: true });
        await input.fill('CTXUSE Check composer geometry');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        await expect(page.locator('.assistant-message')).toContainText('Check composer geometry');
        await expect(page.locator('.context-ring')).toBeVisible();
        // A new chat restores its own default rail, regardless of the initial home-page seed.
        // These fixed composer widths require the full chat lane rather than an overlapping Summary.
        await closeSummary(page);
        await page.locator('.model-btn').focus();
        await page.keyboard.press('Tab');
        await expect(page.locator('.context-ring')).toBeFocused();
        const wrap = page.locator('.composer-wrap');
        const heights: number[] = [];
        for (const width of [748, 641, 640, 521, 520, 480, 421, 420, 320, 312, 748]) {
          heights.push(await measureComposer(page, width));
          if (family.label !== 'ACP' && width >= 420) {
            const effort = page.locator('.model-effort');
            await expect(effort).toBeVisible();
            const sizing = await effort.evaluate((el) => {
              const button = el.parentElement!;
              const style = getComputedStyle(button);
              const parts = [...button.children].filter((part) => getComputedStyle(part).display !== 'none');
              const contents = parts.reduce((sum, part) => {
                const margins = getComputedStyle(part);
                return (
                  sum +
                  Math.max(part.scrollWidth, part.getBoundingClientRect().width) +
                  parseFloat(margins.marginLeft) +
                  parseFloat(margins.marginRight)
                );
              }, 0);
              const available = button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
              return {
                contentsFit: contents + parseFloat(style.columnGap) * (parts.length - 1) <= available + 1,
                effortFits: el.clientWidth + 1 >= el.scrollWidth,
              };
            });
            // Pane width alone says nothing about fit: selection, neighboring controls and font size all matter.
            if (sizing.contentsFit) expect(sizing.effortFits, `fitting reasoning stays whole at ${width}px`).toBe(true);
          }
          if (width === 480) await wrap.screenshot({ path: testInfo.outputPath('reasoning-label.png') });
          if (width === 320) await wrap.screenshot({ path: testInfo.outputPath('narrow-composer.png') });
        }
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
        await input.fill('SLOW check running composer');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        const stop = page.getByRole('button', { name: 'Stop', exact: true });
        await expect(stop).toBeVisible();
        await page.getByRole('button', { name: 'Add files and more', exact: true }).click();
        await page.locator('.add-panel-item', { hasText: 'Turn plan mode on' }).click();
        await expect(page.locator('.composer-left .plan-chip')).toBeVisible();
        await page.getByRole('button', { name: 'Add files and more', exact: true }).click();
        await page.locator('.add-panel-item', { hasText: 'Set a goal to keep pursuing' }).click();
        await expect(page.getByRole('button', { name: 'Clear goal', exact: true })).toBeVisible();
        const runningHeights = [];
        for (const width of [748, 641, 640, 320, 312, 748]) runningHeights.push(await measureComposer(page, width));
        expect(Math.max(...runningHeights) - Math.min(...runningHeights)).toBeLessThanOrEqual(1);
        await measureComposer(page, 320);
        await wrap.screenshot({ path: testInfo.outputPath('narrow-running-composer.png') });
        await page.getByRole('button', { name: 'Clear goal', exact: true }).click();
        await page.locator('.composer-left .plan-chip').click();
        await stop.click();
        await expect(stop).toHaveCount(0);
        // Truncated picker labels still open their complete menus.
        await page.getByRole('button', { name: 'Select model', exact: true }).click();
        await expect(page.locator('.picker')).toBeVisible();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
        await expect(page.locator('.perm-menu')).toBeVisible();
        await page.keyboard.press('Escape');
      });
    });
  }

  test.describe(`unequal split panes at ${fontSize}px`, () => {
    const ids = ['019c0000-0000-7000-8000-000000000091', '019c0000-0000-7000-8000-000000000092'];
    test.use({
      harnesses: 'codex',
      seed: {
        codexThreads: ids.map((id, i) => ({ id, name: `Composer alignment ${i + 1}`, turns: ['Saved message'] })),
        uiState: { summaryOpen: false, prefs: { fontSize, zoomLevel: 0 } },
      },
    });
    test('wide and narrow empty composers share their top and bottom edges', async ({ page, harness }, testInfo) => {
      await sizeViewport(page, harness, 1280, 800);
      const sidebar = page.getByRole('complementary');
      await sidebar.locator(`[data-sidebar-chat="${ids[0]}"]`).click();
      await expect(page.locator(`[data-composer-chat="${ids[0]}"]`)).toBeVisible();
      await closeSummary(page);
      await sidebar.locator(`[data-sidebar-chat="${ids[1]}"]`).click({ modifiers: ['Alt'] });
      const composers = page.locator('.split-pane .composer');
      await expect(composers).toHaveCount(2);
      await closeSummary(page);
      const separator = page.getByRole('separator', { name: 'Resize pane columns', exact: true });
      for (let i = 0; i < 12; i++) await separator.press('ArrowRight');
      const measure = () =>
        composers.evaluateAll((els) =>
          els.map((el) => {
            const { top, bottom, width, height } = el.getBoundingClientRect();
            return { top, bottom, width, height };
          }),
        );
      // the panes follow the keys as the layout settles: measured at once, the split was 66px of its 100 on two main shards
      await expect.poll(async () => ((b) => b[0].width - b[1].width)(await measure())).toBeGreaterThan(100);
      const boxes = await measure();
      expect(boxes[0].width - boxes[1].width).toBeGreaterThan(100);
      expect(boxes[1].width).toBeLessThan(420);
      expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes[0].bottom - boxes[1].bottom)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath('aligned-split-composers.png') });
    });
  });
}
