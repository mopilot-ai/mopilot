// A compacted Claude chat opened from the sidebar still shows what came before its compaction, then the divider and what followed.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

test.use({
  harnesses: 'claude',
  seed: {
    files: ({ home, claudeHome }) => {
      const sessionId = '24112411-1111-4222-8333-444444444444';
      const cwd = path.join(home, 'compacted-chat');
      const folder = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(folder, { recursive: true });
      const at = new Date().toISOString();
      const base = { sessionId, cwd, isSidechain: false, timestamp: at };
      const user = (uuid: string, parentUuid: string | null, text: string, extra = {}) => ({
        ...base,
        type: 'user',
        uuid,
        parentUuid,
        message: { role: 'user', content: text },
        ...extra,
      });
      const reply = (uuid: string, parentUuid: string, text: string) => ({
        ...base,
        type: 'assistant',
        uuid,
        parentUuid,
        message: { id: `msg-${uuid}`, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
      });
      const records = [
        { type: 'custom-title', sessionId, customTitle: 'Compacted chat' },
        user('c0000000-0000-4000-8000-000000000001', null, 'Plan the migration'),
        reply('c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'The plan has three steps'),
        {
          ...base,
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'c0000000-0000-4000-8000-000000000003',
          parentUuid: null,
          logicalParentUuid: 'c0000000-0000-4000-8000-000000000002',
          content: 'Conversation compacted',
          compactMetadata: { trigger: 'manual', preTokens: 1200 },
        },
        user('c0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000003', 'Summary of the migration plan', {
          isCompactSummary: true,
        }),
        // Claude Code writes the user's /compact after the summary it asked for
        user('c0000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000004', '/compact'),
        user('c0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000007', 'Now run step one'),
        reply('c0000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000005', 'Step one is done'),
      ];
      fs.writeFileSync(path.join(folder, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    },
  },
});

test('opening a compacted chat shows its conversation from before the compaction', async ({ page, harness }) => {
  await page.getByRole('complementary').getByRole('button', { name: 'Compacted chat', exact: true }).first().click();
  const main = page.getByRole('main');
  await expect(main.getByText('Now run step one', { exact: true })).toBeVisible();
  await expect(main.getByText('Step one is done', { exact: true })).toBeVisible();
  await expect(main.getByText('Plan the migration', { exact: true })).toBeVisible();
  // the turn before the compaction is a finished one: folded as any is, its reply and the divider inside
  await main
    .getByRole('button', { name: /^Worked for/ })
    .first()
    .click();
  await expect(main.getByText('The plan has three steps', { exact: true })).toBeVisible();
  // the user's own /compact: its divider says so, and it is the only divider
  await expect(main.locator('.divider-label')).toHaveCount(1);
  await expect(main.locator('.divider-label')).toHaveText(/^\s*Context compacted/);
  await expect(main.getByText('/compact', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('compacted-chat.png') });
  // the read was the turns worker's: a worker that can't load the core under Electron leaves this note, and main reads for it
  const ignored = await harness.app.evaluate(
    (_e, file) =>
      (process as any).mainModule
        ?.require(file)
        .recentIgnored()
        .map((e: any) => `${e.context}: ${e.message}`),
    path.resolve('electron/ignored.cjs'),
  );
  expect(ignored.filter((note: string) => note.startsWith('read a Claude Code chat in the worker'))).toEqual([]);
});
