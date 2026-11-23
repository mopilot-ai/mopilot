// A parent's wake-up the harness did not take waits in its queue; removing that row must give the notes it carried back
// to the parent (they left the journal's record when the wake was composed) and must not leave the wake marked in flight
// (#3003 follow-up). The fake Codex refuses turn/start once the test removes its ".unfail" file.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { hasRunningCodexTurn } from './fixtures/codex-running-turn.mjs';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

/** The Codex CLI's own sign-in, as a signed-in user has it. */
const codexLogin = {
  files: ({ codexHome }: { codexHome: string }) => {
    const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
    const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-cuj', chatgpt_plan_type: 'plus' } };
    const tokens = {
      access_token: jwt({ ...auth, exp: 4e9 }),
      id_token: jwt({ ...auth, email: 'cuj@example.test' }),
      refresh_token: 'fake',
      account_id: 'acct-cuj',
    };
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }));
  },
};

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const journal = (h: Harness): any => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8'));
  } catch {
    return { children: {}, deliveries: {}, parents: {} };
  }
};
const wakes = (h: Harness) => Object.entries<any>(journal(h).deliveries ?? {}).filter(([, d]) => d.kind === 'wake');
const BRIEF =
  'This independent linked task belongs to the user’s current request. Preserve its assigned scope and report its own result to the parent session.';

test.use({ harnesses: 'both', seed: codexLogin, env: { FAKE_CODEX_FAIL: 'turn/start' } });

test('a wake-up the user removes from the parent’s queue gives its notes back', async ({ page, harness }, testInfo) => {
  const unfail = `${harness.env.FAKE_CODEX_LOG}.unfail`;
  const release = path.join(harness.dir, 'fake-codex.jsonl.release');
  // turn/start works until the child is running; then the parent's wake-up is refused and waits in its queue
  fs.writeFileSync(unfail, '');
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Model One' }).click();

  // SLOW (the child's turn runs until the test releases it) is a JSON escape: the parent's own message holds the brief
  const start = `MCPCU start_session ${JSON.stringify({
    initiation: 'user_asked',
    context: 'fresh',
    use_worktree: false,
    title: 'Wake worker',
    prompt: 'Report the schema result SLOW',
    background: BRIEF,
  }).replace(/SLOW/g, 'SL\\u004fW')}`;
  await composer(page).fill(start);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => Object.keys(journal(harness).children ?? {}).length, { timeout: 60_000 }).toBe(1);
  await expect
    // A request is logged before admission, and the parent's own request carries the escaped child brief.
    // Wait for the actual accepted child turn before making later parent turns fail.
    .poll(() => hasRunningCodexTurn(harness.env.FAKE_CODEX_LOG!, 'Report the schema result SLOW'))
    .toBe(true);

  // the child finishes, the parent is idle, and the harness refuses the wake-up: it waits first in the parent's queue
  fs.rmSync(unfail);
  fs.writeFileSync(release, '');
  await expect.poll(() => wakes(harness).length, { timeout: 60_000 }).toBe(1);
  const [wakeId, wake] = wakes(harness)[0];
  expect(wake.notes).toHaveLength(1);
  expect(journal(harness).parents[wake.chatId].notes).toHaveLength(0);
  const row = page.locator('.queue-row').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('queued-wake.png') });

  // removing it gives the notes back, and the wake no longer counts
  await row.getByRole('button', { name: 'Remove from queue' }).click();
  await expect(page.locator('.queue-row')).toHaveCount(0);
  await expect.poll(() => typeof journal(harness).deliveries[wakeId].removedAt, { timeout: 15_000 }).toBe('number');
  const parent = journal(harness).parents[wake.chatId];
  expect(parent.notes).toHaveLength(1);
  expect(parent.notes[0].childId).toBe(wake.notes[0].childId);
  expect(parent.notes[0].body).toBe(wake.notes[0].body);
  expect(parent.wakes).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('queued-wake-removed.png') });
});
