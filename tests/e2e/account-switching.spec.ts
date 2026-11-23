// A Claude chat that runs out of usage moves to another Claude login of the same billing type and
// carries on there, in the real app against tests/e2e/fixtures/fake-claude.mjs. The CLI's own login
// (~/.claude) is out of usage (a .fake-limited marker); the added login "second" is not. The policy lives in main
// (WP3-7), so it also holds with no window open: a due scheduled Claude goal that hits the limit moves on by itself.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

function limitedDefaultAndSecond(d: Dirs) {
  fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), '');
  const second = { id: 'second', email: 'second@example.test', subscriptionType: 'max', authMethod: 'claude.ai', loggedIn: true };
  fs.writeFileSync(
    path.join(d.userData, 'claude-accounts.json'),
    JSON.stringify({ active: 'default', autoSwitch: true, accounts: [second] }),
  );
}

async function newClaudeChat(page: Page, text: string) {
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** What each fake CLI process read, with the login folder it ran as. */
function inputsByLogin(h: Harness) {
  const dirOf = new Map<number, string>();
  const out: { login: string; text: string; human: boolean }[] = [];
  for (const l of h.claudeLog()) {
    if (l.kind === 'argv' && (l as any).configDir) dirOf.set(l.pid, path.basename((l as any).configDir));
    if (l.kind === 'in' && l.msg?.type === 'user') {
      const c = l.msg.message?.content;
      const text =
        typeof c === 'string'
          ? c
          : (c ?? [])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n');
      out.push({ login: dirOf.get(l.pid) ?? '?', text, human: l.msg.origin?.kind === 'human' });
    }
  }
  return out;
}

test.use({ harnesses: 'claude', seed: { files: limitedDefaultAndSecond } });

test('account switch: a Claude chat out of usage continues on the other subscription, with a note', async ({ page, harness }) => {
  await newClaudeChat(page, 'hello there');
  const note = transcript(page).getByText(/^Max limit reached(?: on \S+)?\. Continued on second@example\.test$/);
  await expect(note).toBeVisible();
  // the session restarted as the other login and was told to go on
  await expect(transcript(page).getByText('fake-claude: Continue where you left off.', { exact: true })).toBeVisible();
  const sent = inputsByLogin(harness);
  expect(sent.find((m) => m.text === 'hello there')?.login).toBe('.claude');
  expect(sent.find((m) => m.text === 'Continue where you left off.')).toMatchObject({ login: 'second', human: false });

  // the note is kept in the chat's file: it is still there after the window reloads
  await page.reload();
  await page.getByRole('complementary').getByText('Fake chat title', { exact: true }).click();
  await expect(transcript(page).getByText('fake-claude: Continue where you left off.', { exact: true })).toBeVisible();
  await expect(note).toBeVisible();
});

test('account switch: a running Claude goal is set again on the new login, unattended', async ({ page, harness }) => {
  await newClaudeChat(page, '/goal finish the list');
  await expect(
    transcript(page).getByText(/^Max limit reached(?: on \S+)?\. Continued on second@example\.test · Goal and plan mode carried over$/),
  ).toBeVisible();
  // the condition went out again as Sage's own message, as the new login
  await expect
    .poll(() =>
      inputsByLogin(harness)
        .filter((m) => m.text === '/goal finish the list')
        .map((m) => [m.login, m.human]),
    )
    .toEqual([
      ['.claude', true],
      ['second', false],
    ]);
  // and the goal ran to completion there
  await expect(transcript(page).getByText('fake-claude: done with finish the list').first()).toBeVisible();
});

test.describe('with no window open', () => {
  const seed = {
    uiState: { prefs: { runSchedules: true } },
    files: (d: Dirs & { codexHome: string }) => {
      limitedDefaultAndSecond(d);
      const dir = path.join(d.codexHome, 'automations', 'quiet-goal');
      fs.mkdirSync(dir, { recursive: true });
      const toml = [
        'version = 1',
        'id = "quiet-goal"',
        'kind = "cron"',
        'name = "Quiet goal"',
        "prompt = '/goal finish the list'",
        'status = "ACTIVE"',
        'rrule = "FREQ=MINUTELY;INTERVAL=1"',
        'harness = "claude"',
        `updated_at = ${Date.now()}`,
        '',
      ];
      fs.writeFileSync(path.join(dir, 'automation.toml'), toml.join('\n'));
    },
  };
  test.use({ harnesses: 'both', seed });

  test('account switch: an unattended Claude goal that hits the limit moves to the other login and is set again, with the note', async ({
    page,
    harness,
  }) => {
    test.skip(process.platform !== 'darwin', 'the app stays running with no window on macOS only');
    await expect(home(page)).toBeVisible();
    await page.close();
    await expect.poll(() => harness.app.windows().length).toBe(0);
    // move main's scheduler clock on until the due task has run, on the first login, and then on the second
    await expect
      .poll(
        async () => {
          if (inputsByLogin(harness).some((m) => m.text === '/goal finish the list' && m.login === 'second')) return true;
          await harness.app.evaluate(() => (globalThis as any).__schedulerAdvance(61_000));
          return false;
        },
        { intervals: [3000], timeout: 50_000 },
      )
      .toBe(true);
    expect(
      inputsByLogin(harness)
        .filter((m) => m.text === '/goal finish the list')
        .map((m) => [m.login, m.human]),
    ).toEqual([
      ['.claude', false],
      ['second', false],
    ]);
    await expect.poll(() => harness.app.windows().length).toBe(0);
    // the note was written into the chat's file by main: the window that opens next shows it
    await harness.app.evaluate(({ app }) => app.emit('activate'));
    const page2 = harness.app.windows()[0] ?? (await harness.app.waitForEvent('window'));
    await page2
      .getByRole('complementary')
      .getByText(/finish the list|Fake chat title/)
      .first()
      .click();
    await expect(
      page2.getByRole('main').getByText(/limit reached(?: on \S+)?\. Continued on second@example\.test · Goal and plan mode carried over$/),
    ).toBeVisible({ timeout: 20_000 });
  });
});
