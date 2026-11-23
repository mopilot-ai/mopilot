// MoMo's Outputs (#2139, designs/momo-outputs), on fake Claude Code and fake Codex with MoMo's session under real confinement (no built-in tools; `--tools ""` on Claude Code): the panel's Outputs section starts empty; momo_save_file saves a csv with no approval card and the file appears in the panel; a name with a folder in it is refused and saves nothing; the same name again is a numbered second file; Delete in a file's menu removes it and the empty state comes back.
import { test, expect } from './fixtures/app';
import { sizeViewport } from './fixtures/window';
import { momoChatSession, momoSeed, momoSetupDone, openMomo } from './fixtures/momo';

// needs a Mac: the harness reaches MoPilot's tools through sage-mcp, which builds only on macOS
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const save = (args: object) => `CUCALL momo_save_file ${JSON.stringify(args)}`;
const CSV = { name: 'meetings.csv', content: 'title,when\n=HYPERLINK("http://evil.test","x"),Mon\n', note: 'next week' };

for (const harnesses of ['claude', 'codex'] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({
      harnesses,
      env: { MOPILOT_MOMO_DEV: '1', MOPILOT_FLAGS: 'momo.outputs=1' },
      seed: { ...momoSetupDone, ...momoSeed(harnesses).seed },
    });

    test('a saved file shows in the panel with no card; a path in the name is refused; Delete empties it again', async ({
      page,
      harness,
    }) => {
      test.setTimeout(150_000);
      await sizeViewport(page, harness, 1680, 900);
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);
      const panel = page.getByRole('region', { name: 'MoMo details' });
      await expect(panel.getByRole('heading', { name: 'Outputs' })).toBeVisible();
      await expect(panel.getByText('Files MoMo makes show up here.')).toBeVisible();

      await send(save(CSV));
      await expect(panel.getByRole('button', { name: 'Open meetings.csv' })).toBeVisible({ timeout: 30_000 });
      await expect(chat.locator('[data-kind="momoAction"]')).toHaveCount(0);
      await expect(panel.getByText('Stored on this Mac, not encrypted. Reset MoMo deletes them.')).toBeVisible();
      await expect(panel.getByText('After reading your data')).toHaveCount(0);

      // a folder in the name is refused and nothing is saved
      await send(save({ name: '../escape.md', content: 'x' }));
      await expect(chat.getByText(/The name must be a plain file name/)).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByRole('button', { name: /^Open / })).toHaveCount(1);

      // the same name makes a second file
      await send(save(CSV));
      await expect(panel.getByRole('button', { name: 'Open meetings (2).csv' })).toBeVisible({ timeout: 30_000 });

      // a spreadsheet main builds from rows
      await send(
        `CUCALL momo_save_sheet ${JSON.stringify({
          name: 'budget',
          rows: [
            ['item', 'cost'],
            ['=SUM(A1)', 12],
          ],
        })}`,
      );
      await expect(panel.getByRole('button', { name: 'Open budget.xlsx' })).toBeVisible({ timeout: 30_000 });
      await expect(chat.locator('[data-kind="momoAction"]')).toHaveCount(0);

      // Delete, then the empty state
      for (const name of ['budget.xlsx', 'meetings (2).csv', 'meetings.csv']) {
        await panel.getByRole('button', { name: `Actions for ${name}` }).click();
        await panel.getByRole('menuitem', { name: 'Delete', exact: true }).click();
        await expect(panel.getByRole('button', { name: `Open ${name}` })).toHaveCount(0);
      }
      await expect(panel.getByText('Files MoMo makes show up here.')).toBeVisible();
    });
  });
}
