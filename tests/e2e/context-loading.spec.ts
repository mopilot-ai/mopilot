// A delayed context read in the real sidebar shows a shaped loading state, failure recovery and the final composition.
// e2e-covers: src/harness/usageWindows.ts src/components/accounts/meters.tsx src/components/composer/ContextRing.tsx src/components/composer/ComposerPlanLimits.tsx src/styles/app/context-summary.css src/styles/app/context.css
import { test, expect } from './fixtures/app';
import { emptySnapshot, withClaudeBreakdown } from '../../shared/contextSnapshot.mjs';

const SESSION = '5e3d9a8c-1b2f-4c6d-9e7a-0f1e2d3c4b5a';
test.use({
  harnesses: 'claude',
  seed: {
    claudeSessions: [{ id: SESSION, cwd: 'old-project', title: 'Context loading check', turns: ['an old message'] }],
    uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0, theme: 'system' } },
  },
});

test('the context disclosure responds while reading, retries, and replaces its placeholders with categories', async ({
  page,
  harness,
}, info) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Hold the real IPC boundary so the UI is inspected before any result exists.
  await harness.app.evaluate(({ ipcMain }) => {
    const state = { owner: '', pending: [] as ((value: unknown) => void)[] };
    (globalThis as any).__contextLoadingCheck = state;
    ipcMain.removeHandler('context:get');
    ipcMain.removeHandler('context:refresh');
    ipcMain.handle('context:get', () => null);
    ipcMain.handle('context:refresh', (_event, owner) => {
      state.owner = owner;
      return new Promise((resolve) => state.pending.push(resolve));
    });
  });
  await page.getByRole('complementary').getByText('Context loading check', { exact: true }).first().click();
  await expect(page.getByRole('main').getByText('fake-claude: an old message', { exact: true })).toBeVisible();
  await expect
    .poll(() => page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('24px');
  const card = page.locator('.summary-context');
  await expect(card).toBeVisible();
  await card.locator('summary').click();
  const loading = card.getByRole('status', { name: 'Loading context breakdown' });
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await expect(loading.locator('.ctx-loading-row')).toHaveCount(5);
  await expect(card).not.toContainText('Waiting for a report');
  await expect
    .poll(() =>
      loading.locator('.ctx-loading-shapes').evaluate((el) => el.getAnimations({ subtree: true }).some((a) => a.playState === 'running')),
    )
    .toBe(true);
  await expect.poll(() => card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const attachView = async (name: string) => {
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const expectFit = async (panel: typeof card) => {
    await expect
      .poll(() =>
        panel.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return [...el.querySelectorAll('*')]
            .filter((child) => {
              const box = child.getBoundingClientRect();
              return box.width > 0 && (box.right > bounds.right + 1 || box.left < bounds.left - 1);
            })
            .map((child) => child.getAttribute('class') || child.tagName);
        }),
      )
      .toEqual([]);
    await expect.poll(() => panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  };
  await attachView('context-loading-narrow-large-font');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() => loading.locator('.ctx-loading-shapes').evaluate((el) => getComputedStyle(el, '::after').animationName))
    .toBe('none');
  // A failed/empty read leaves an honest state and a usable retry.
  await harness.app.evaluate(() => {
    const state = (globalThis as any).__contextLoadingCheck;
    for (const resolve of state.pending.splice(0)) resolve(null);
  });
  await expect(card).toContainText('Context unavailable');
  await expect(loading).toHaveCount(0);
  await card.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(loading).toBeVisible();
  const owner = await harness.app.evaluate(() => (globalThis as any).__contextLoadingCheck.owner as string);
  const snapshot = withClaudeBreakdown(
    emptySnapshot(owner, Date.now()),
    {
      totalTokens: 60000,
      maxTokens: 200000,
      categories: [
        { name: 'System prompt', tokens: 10000, kind: 'used' },
        { name: 'System tools', tokens: 10000, kind: 'used' },
        { name: 'Messages', tokens: 40000, kind: 'used' },
      ],
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167000,
    },
    Date.now(),
  );
  await harness.app.evaluate((_electron, value) => {
    const state = (globalThis as any).__contextLoadingCheck;
    for (const resolve of state.pending.splice(0)) resolve(value);
  }, snapshot);
  await expect(loading).toHaveCount(0);
  await expect(card.locator('.ctx-big')).toHaveText('30%');
  await expect(card.locator('.ctx-legend-row', { hasText: 'Conversation' })).toContainText('40k');
  for (let i = 0; i < 3; i++) {
    await card.locator('summary').click();
    await card.locator('summary').click();
    await expect(card.locator('.ctx-big')).toHaveText('30%');
    await expect(loading).toHaveCount(0);
  }
  await attachView('context-loaded-narrow-large-font');
  await expectFit(card);
  const links = await card.locator('.ctx-foot-link').evaluateAll((nodes) =>
    nodes.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }),
  );
  expect(links[1].top).toBeGreaterThanOrEqual(links[0].bottom);
  await card.locator('.ctx-foot').scrollIntoViewIfNeeded();
  await attachView('context-sidebar-actions-large-font');
  await page.locator('.context-ring').click();
  const popover = page.locator('.ctx-popover');
  await expect(popover.locator('.ctx-summary-value')).toHaveText('30% used');
  await expect(popover.locator('.ctx-legend, .ctx-compact, .ctx-status')).toHaveCount(0);
  await expect(popover.getByRole('button', { name: 'Refresh usage' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'All usage' })).toBeVisible();
  await expect(popover.locator('.limit-row-reset')).toHaveCount(2);
  await expectFit(popover);
  await attachView('context-popover-large-font');
  for (const color of ['dark', 'light'] as const) {
    await harness.app.evaluate(({ nativeTheme }, value) => {
      nativeTheme.themeSource = value;
    }, color);
    await expect(page.locator('html')).toHaveAttribute('data-theme', color);
    await page.waitForTimeout(600);
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await popover.boundingBox();
      expect(bounds?.width).toBeLessThanOrEqual(300);
      await expect(popover).toBeInViewport({ ratio: 1 });
      await expectFit(popover);
      for (const reset of await popover.locator('.limit-row-reset').all()) {
        await expect(reset).toBeVisible();
        // Reset copy includes a clock time and may wrap; every text fragment must remain readable.
        const text = await reset.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const boxes = [el.getBoundingClientRect(), el.closest('.ctx-popover')!.getBoundingClientRect()];
          const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
          return {
            label: el.textContent,
            fragments: rects.length,
            fits: rects.every((rect) =>
              boxes.every(
                (box) =>
                  rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
              ),
            ),
          };
        });
        expect(text.label).toMatch(/^Resets /);
        expect(text.fragments).toBeGreaterThan(0);
        expect(text.fits, text.label ?? 'reset time').toBe(true);
      }
      await attachView(`context-quick-view-${color}-${width}`);
    }
  }
  await page.evaluate(() => document.documentElement.style.setProperty('--fs-chat', '14px'));
  await expect
    .poll(() => page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('14px');
  await expectFit(popover);
  await attachView('context-quick-view-default-font');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await page.locator('.context-ring').click();
    await expect(popover.locator('.ctx-summary-value')).toHaveText('30% used');
  }
  const viewContext = popover.getByRole('button', { name: 'View context', exact: true });
  await viewContext.focus();
  await page.keyboard.press('Enter');
  const details = page.locator('.dialog', { has: page.getByText('Context', { exact: true }) });
  await expect(popover).toHaveCount(0);
  await expect(details.locator('.ctx-card-big')).toHaveText('30%');
  await expect(details.getByRole('button', { name: 'Compact now', exact: true })).toBeVisible();
});
