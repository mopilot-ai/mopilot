// The Summary island beside a chat at a narrow window and large Chat font never covers the composer's controls (#2461).
// e2e-covers: src/components/panels/SummaryPanel.tsx src/components/panels/SummaryActivity.tsx src/styles/app/summary-panel.css
import { test, expect } from './fixtures/app';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

for (const family of [
  { label: 'Codex', harnesses: 'codex', acp: {} },
  { label: 'Claude Code', harnesses: 'claude', acp: {} },
  { label: 'ACP', harnesses: 'none', acp: { kimi: { resume: true } } },
] as const) {
  test.describe(`Summary beside the composer on ${family.label}`, () => {
    test.use({
      harnesses: family.harnesses,
      acp: family.acp,
      seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } },
    });

    for (const [width, sidebar] of [
      [1024, 'open'],
      [1024, 'closed'],
      [760, 'open'],
      [760, 'closed'],
    ] as const) {
      test(`Stop takes a pointer click at ${width}x682 with the sidebar ${sidebar}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 682 });
        await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
        const composer = page.getByRole('textbox', { name: 'Message', exact: true });
        // The Claude fixture adds a five-step plan; every harness adds a link and keeps the turn running.
        const items = ['Check pull requests', 'Resolve conflicts', 'Push the branch', 'Wait for checks', 'Build the package'].map(
          (content, i) => ({ content, status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending' }),
        );
        // the Claude fake runs the plan call; on every harness a shared link fills Sources, and SLOW keeps the turn running
        const plan = family.harnesses === 'claude' ? `\nCUCALL update_task_list ${JSON.stringify({ items })}` : '';
        await composer.fill(`SLOW see https://example.com/spec${plan}`);
        await composer.press('Enter');
        const stop = page.getByRole('button', { name: 'Stop', exact: true });
        await expect(stop).toBeVisible();
        if (sidebar === 'closed') {
          await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
          await expect(page.getByRole('complementary')).toBeHidden();
        }
        // beside the open sidebar a 760px window has no room for the island, which gives way (#4158): open it anyway
        if (width === 760 && sidebar === 'open') await page.getByRole('button', { name: 'Summary', exact: true }).click();
        await expect(page.locator('.summary-panel')).toBeVisible();
        // every control on the composer's row is the topmost element at its own center
        const covered = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.composer button, .composer [role="button"]')]
            .filter((el) => el.getClientRects().length > 0)
            .flatMap((el) => {
              const r = el.getBoundingClientRect();
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return top && (el === top || el.contains(top))
                ? []
                : [`${el.getAttribute('aria-label') ?? el.textContent?.trim()} under ${top?.className ?? 'nothing'}`];
            }),
        );
        const rects = await page.evaluate(() =>
          Object.fromEntries(
            ['.main-content', '.summary-slot', '.summary-panel', '.composer', '.composer-right', '.thread-view', 'aside'].map(
              (s) => [s, document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null] as const,
            ),
          ),
        );
        await info.attach('layout', { body: JSON.stringify({ covered, rects }, null, 2), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath(`${family.harnesses}-${width}-${sidebar}.png`) });
        expect(covered).toEqual([]);
        // an ordinary pointer click, not a forced one
        await stop.click({ timeout: 5_000 });
        await expect(stop).toHaveCount(0);
      });
    }
  });
}
