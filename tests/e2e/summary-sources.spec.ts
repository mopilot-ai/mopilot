// The real Sources + journey on every harness: empty entry, draft-safe validation/cancel, repeated links and send.
// e2e-covers: src/components/panels/SummaryPanel.tsx src/components/panels/SummaryConnectors.tsx src/components/panels/SummaryContext.tsx src/components/panels/SummarySources.tsx src/styles/app/summary-panel.css
import { test, expect } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

for (const family of [
  { label: 'Codex', harnesses: 'codex', reply: 'fake-codex', acp: {} },
  { label: 'Claude Code', harnesses: 'claude', reply: 'fake-claude', acp: {} },
  { label: 'ACP', harnesses: 'none', reply: 'fake-acp', acp: { kimi: { resume: true } } },
] as const) {
  test.describe(`Sources on ${family.label}`, () => {
    test.use({
      harnesses: family.harnesses,
      acp: family.acp,
      // Explicit current zoom avoids migrating the large font as a legacy zoom shortcut (shared/zoom.mjs).
      seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } },
    });

    test('adds complete links to the next message, then lists the shared sources', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      const send = page.getByRole('button', { name: 'Send', exact: true });
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      await composer.fill('hello sources');
      await send.click();
      await expect(page.getByRole('main').getByText(`${family.reply}: hello sources`, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect.poll(() => composer.evaluate((el) => getComputedStyle(el).fontSize)).toBe('24px');

      const rail = page.locator('.summary-panel');
      await expect
        .poll(() =>
          rail.evaluate((el) => {
            const header = el.querySelector('.summary-card summary')!;
            const bounds = el.getBoundingClientRect();
            return {
              headerMinimum: getComputedStyle(header).minHeight,
              cornerRadius: getComputedStyle(el).borderRadius,
              compactType: Number.parseFloat(getComputedStyle(el).fontSize) < 21,
              cardsFit: [...el.children]
                .filter((child) => child.getClientRects().length > 0)
                .every((child) => {
                  const box = child.getBoundingClientRect();
                  return box.left >= bounds.left && box.right <= bounds.right;
                }),
              horizontalOverflow: el.scrollWidth > el.clientWidth,
            };
          }),
        )
        .toEqual({ headerMinimum: '32px', cornerRadius: '10px', compactType: true, cardsFit: true, horizontalOverflow: false });
      // the Connectors card is absent for a session with no connectors (as Claude Desktop's); Context folds the same way
      const context = rail.locator('.summary-context');
      await context.locator('summary').focus();
      await context.locator('summary').press('Enter');
      await expect(context).toHaveAttribute('open');
      await context.locator('summary').press('Enter');
      await expect(context).not.toHaveAttribute('open');

      const sources = page.locator('.summary-section');
      const addSource = sources.getByRole('button', { name: 'Add source', exact: true });
      const url = sources.getByRole('textbox', { name: 'Source URL', exact: true });
      const add = sources.getByRole('button', { name: 'Add to message', exact: true });
      // the Add source row is the section's own; shared sources are the other rows
      await expect(sources.locator('.summary-row:not(.summary-source-add)')).toHaveCount(0);
      await composer.fill('Compare these sources');
      await addSource.click();
      await expect(url).toBeFocused();
      await expect(url).toBeEmpty();
      await expect(add).toBeDisabled();
      await expect(composer).toHaveText('Compare these sources');
      await url.fill('https://');
      await add.click();
      await expect(sources.getByRole('alert')).toContainText('Enter a valid');
      await expect(url).toHaveValue('https://');
      await expect(composer).toHaveText('Compare these sources');
      await url.press('Escape');
      await expect(url).toHaveCount(0);
      await expect(addSource).toBeFocused();
      await expect(composer).toHaveText('Compare these sources');

      const links = ['https://example.com/one', 'https://example.com/two', 'https://example.org/three'];
      for (const [index, link] of links.entries()) {
        await addSource.click();
        await expect(url).toBeFocused();
        await url.fill(index === 0 ? 'example.com/one' : link);
        await expect(sources.getByRole('alert')).toHaveCount(0);
        await expect.poll(() => sources.locator('form').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        if (index === 0) await page.screenshot({ path: testInfo.outputPath('source-form-narrow-large-font.png') });
        await url.press('Enter');
        await expect(url).toHaveCount(0);
        await expect(composer).toBeFocused();
        await expect(composer).toHaveText(['Compare these sources', ...links.slice(0, index + 1)].join('\n'));
        // The source action only edits the next message; the initial turn is still the sole sent prompt.
        await expect(page.getByRole('main').locator('.user-message')).toHaveCount(1);
      }
      await send.click();
      await expect(page.getByRole('main').getByText(`${family.reply}: Compare these sources`, { exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(sources).toContainText('example.com');
      await expect(sources).toContainText('example.org');
      await sources.getByRole('button', { name: 'Show all 3 links', exact: true }).click();
      for (const link of links) await expect(sources.getByTitle(link, { exact: true })).toBeVisible();
      await sources.getByRole('button', { name: 'Show less', exact: true }).click();
      await expect(sources.locator('.summary-row[title]:not(.summary-source-add)')).toHaveCount(2);
    });
  });
}
