// Fanout titles appear before a child's first turn on every harness and survive a reload of that child's open chat.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

test.use({
  harnesses: 'both',
  acp: { kimi: {} },
  seed: { uiState: { prefs: { defaultHarness: 'claude', fontSize: 24, zoomLevel: 0 } } },
});

const children = (h: Harness): Record<string, any> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8')).children ?? {};
  } catch {
    return {};
  }
};

const start = (args: object) =>
  `CUCALL start_session ${JSON.stringify({
    initiation: 'user_asked',
    use_worktree: false,
    background:
      'The user requested separate tasks on Codex, Claude Code and Kimi Code; each child owns its own file and reports to this parent.',
    ...args,
  }).replace(/SLOW/g, 'SL\\u004fW')}`;

for (const reloadHarness of ['codex', 'claude', 'acp:kimi']) {
  test(`fanout titles precede every first turn, including the open ${reloadHarness} chat after reload`, async ({ page, harness }, info) => {
    test.skip(process.platform !== 'darwin', 'ACP admission needs the macOS sage-mcp build');
    await page.setViewportSize({ width: 1024, height: 682 });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    const sidebar = page.getByRole('complementary');
    await expect(composer).toBeVisible();
    await openHarnessList(page);
    await expect(page.locator('.hp-row[data-harness="kimi"]')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    const tasks = [
      { title: 'Codex title timing', harness: 'codex', paths: ['codex.md'] },
      { title: 'Claude title timing', harness: 'claude', paths: ['claude.md'] },
      { title: 'Kimi title timing', harness: 'acp:kimi', paths: ['kimi.md'] },
    ];
    try {
      await composer.fill(
        [
          'Use Codex for the producer and Codex child. Use Claude Code for the Claude child. Use Kimi Code for the Kimi child. Keep the title tasks waiting for the producer.',
          start({ title: 'Producer', name: 'producer', prompt: 'Produce the input SLOW', harness: 'codex', paths: ['producer.md'] }),
          ...tasks.map((task) => start({ ...task, prompt: 'Check the input', after: ['producer'] })),
        ].join('\n'),
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => Object.keys(children(harness)).length).toBe(4);
      await test.step('all three actual harnesses show their supplied names before their first turn', async () => {
        const linked = await page.evaluate(() => window.native.orchestration.snapshot());
        for (const task of tasks) {
          const entry = Object.entries(children(harness)).find(([, child]) => child.title === task.title)!;
          expect(entry).toBeTruthy();
          const [id, child] = entry;
          expect(child.harness).toBe(task.harness);
          if (task.harness.startsWith('acp:')) expect(id).toMatch(/^acp:kimi:/);
          expect(linked.waiting?.[id]?.after).toHaveLength(1);
          const row = sidebar.locator(`[data-sidebar-chat=${JSON.stringify(id)}]`);
          await expect(row).toHaveAccessibleName(task.title);
          await row.click();
          await expect(page.locator('.tb-title-text')).toHaveText(task.title);
        }
        await page.screenshot({ path: info.outputPath('fanout-titles-before-first-turn.png') });
      });
      await test.step(`a window opened on the ${reloadHarness} chat keeps its supplied name after reload`, async () => {
        const [id, child] = Object.entries(children(harness)).find(
          ([, child]) => child.harness === reloadHarness && child.title !== 'Producer',
        )!;
        const row = sidebar.locator(`[data-sidebar-chat=${JSON.stringify(id)}]`);
        await expect
          .poll(() =>
            page.evaluate(async (id) => {
              const saved = (await window.native.state.read()) as { sidebarSnapshot?: { rows?: { id: string }[] } };
              return saved?.sidebarSnapshot?.rows?.some((row) => row.id === id) ?? false;
            }, id),
          )
          .toBe(true);
        // A normal row click does not change the window's URL. The supported new-window action carries the chat hash through reload.
        const [target] = await Promise.all([harness.app.waitForEvent('window'), row.click({ modifiers: ['Meta'] })]);
        await target.waitForLoadState('domcontentloaded');
        expect(new URLSearchParams(new URL(target.url()).hash.slice(1)).get('thread')).toBe(id);
        await target.setViewportSize({ width: 1024, height: 682 });
        const targetRow = target.getByRole('complementary').locator(`[data-sidebar-chat=${JSON.stringify(id)}]`);
        await expect(targetRow).toHaveAttribute('aria-current', 'page');
        await expect(target.locator('.tb-title-text')).toHaveText(child.title);
        await target.reload();
        // A seeded row can appear before its native list answers; check the supported open-chat retention after reconciliation.
        await expect
          .poll(() =>
            target.evaluate(() =>
              ['mopilot:boot:done', 'mopilot:chats:claude'].every((name) => performance.getEntriesByName(name).length > 0),
            ),
          )
          .toBe(true);
        const linked = await target.evaluate(() => window.native.orchestration.snapshot());
        expect(linked.waiting?.[id]?.after).toHaveLength(1);
        await expect(targetRow).toHaveAccessibleName(child.title);
        await expect(targetRow).toHaveAttribute('aria-current', 'page');
        await expect(target.locator('.tb-title-text')).toHaveText(child.title);
        await target.screenshot({ path: info.outputPath('open-chat-title-after-reload.png') });
      });
    } finally {
      fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.release'), '');
    }
  });
}
