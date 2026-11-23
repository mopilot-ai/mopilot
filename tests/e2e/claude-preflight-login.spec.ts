// A Claude chat does not start its turn on a login main already knows is out of usage: the CLI's own login (~/.claude)
// is saved as limited (claude-login-marks.json, as a run before this one left it), the added login "second" is not, so
// the first message goes to "second" directly, with the usual note, and no turn runs out first. The same repro as
// account-switching.spec.ts, where the limit is only learned from the failed turn. And the same when the only thing known
// is what the CLI's /usage says of the login (nothing left), with no turn ever refused and no offer to pay for access.
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
  fs.writeFileSync(path.join(d.userData, 'claude-login-marks.json'), JSON.stringify({ default: { limitedUntil: Date.now() + 3_600_000 } }));
}

/** The login folder each fake CLI process ran as, with what it was sent. */
function inputsByLogin(h: Harness) {
  const dirOf = new Map<number, string>();
  const out: { login: string; text: string }[] = [];
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
      out.push({ login: dirOf.get(l.pid) ?? '?', text });
    }
  }
  return out;
}

test.use({ harnesses: 'claude', seed: { files: limitedDefaultAndSecond } });

test('a chat whose login is saved as out of usage starts its first turn on the other login, with no failed turn', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await composer(page).fill('hello there');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-claude: hello there', { exact: true })).toBeVisible();
  await expect(transcript(page).getByText(/^Max limit reached(?: on \S+)?\. Continued on second@example\.test$/)).toBeVisible();
  const sent = inputsByLogin(harness);
  // helpers (a title, a probe) may still run on the CLI's own login; the user's message and any retry must not
  expect(sent.filter((m) => m.text === 'hello there').map((m) => m.login)).toEqual(['second']);
  expect(
    sent.some((m) => m.text === 'Continue where you left off.'),
    'nothing had to be continued',
  ).toBe(false);
});

test.describe('a login that /usage says has nothing left, though no turn was refused', () => {
  test.use({
    seed: {
      files: (d: Dirs) => {
        limitedDefaultAndSecond(d);
        // nothing saved from an earlier run: the window's read of /usage is all that says the CLI's own login is out
        fs.rmSync(path.join(d.userData, 'claude-login-marks.json'));
        fs.writeFileSync(path.join(d.claudeHome, '.fake-usage-full'), '');
      },
    },
  });

  test('the first turn starts on the other login, and no offer to pay for access is made', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    // opening the accounts list reads each login's /usage: the CLI's own says it is used up
    await expect(page.getByText(/Limit reached/).first()).toBeVisible({ timeout: 30_000 });
    // #4339: the harness row names the login the next turn runs on (Automatic moves off the used-up one), not "Limit reached"
    const row = page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).locator('.menu-desc');
    await expect(row).toHaveAttribute('data-account', 'claude:second');
    await expect(row).toHaveText(/^\d+% left$/);
    await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
    await composer(page).fill('hello there');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(transcript(page).getByText('fake-claude: hello there', { exact: true })).toBeVisible();
    await expect(transcript(page).getByText(/^Max limit reached(?: on \S+)?\. Continued on second@example\.test$/)).toBeVisible();
    const sent = inputsByLogin(harness);
    expect(sent.filter((m) => m.text === 'hello there').map((m) => m.login)).toEqual(['second']);
    expect(sent.some((m) => m.text === 'Continue where you left off.')).toBe(false);
    await expect(page.getByText(/reached its subscription limit/)).toHaveCount(0);
  });
});

// #3157: the CLI's own login reads signed out until its first status read. A turn waits (bounded) for that read
// before it starts, so a limit on "second" then moves the chat to the CLI login instead of offering to pay.
test.describe("a limit on the first turn, before the CLI's own login has been read", () => {
  test.use({
    seed: {
      files: (d: Dirs) => {
        // the added login "second" is in use and out of usage; the CLI's own login has quota but its status read is held
        const second = { id: 'second', email: 'second@example.test', subscriptionType: 'max', authMethod: 'claude.ai', loggedIn: true };
        fs.writeFileSync(
          path.join(d.userData, 'claude-accounts.json'),
          JSON.stringify({ active: 'second', autoSwitch: true, accounts: [second] }),
        );
        fs.mkdirSync(path.join(d.userData, 'claude-accounts', 'second'), { recursive: true });
        fs.writeFileSync(path.join(d.userData, 'claude-accounts', 'second', '.fake-limited'), '');
        fs.writeFileSync(path.join(d.claudeHome, '.fake-status-hold'), '');
      },
    },
  });

  test('the turn waits for that read, then the limit moves the chat to the CLI login, with no offer to pay', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
    await composer(page).fill('hello there');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // the read is held: nothing reaches a CLI yet
    await page.waitForTimeout(1_000);
    expect(inputsByLogin(harness).some((m) => m.text === 'hello there')).toBe(false);
    fs.rmSync(path.join(harness.dir, 'home', '.claude', '.fake-status-hold'), { force: true });
    await expect(transcript(page).getByText(/^Max limit reached(?: on \S+)?\. Continued on fake-user@example\.test$/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(transcript(page).getByText('fake-claude: Continue where you left off.', { exact: true })).toBeVisible();
    await expect(page.getByText(/reached its subscription limit/)).toHaveCount(0);
  });
});
