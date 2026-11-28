// MoMo's launched core as ONE journey (#5800), on Claude Code and Codex fakes, through the real gate: a signed-in MoPilot account whose
// /api/me holds the `momo` feature (a seeded sign-in and a fake account service; no MOPILOT_MOMO_DEV). The sidebar's MoMo row shows,
// setup finishes, a turn is answered, a fact is saved and shows in Memory › Facts, the next turn recalls it, and a Calendar read asks to
// connect, connects and reads today's event. Signed out, or with the momo.enabled kill switch off, the same account service shows no MoMo.
import fs from 'node:fs';
import http from 'node:http';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoView, momoChat, momoChatSession, momoReply, momoRow, openMomo, settingsGroup } from './fixtures/momo';

// needs a Mac: the harness reaches MoMo's tools through sage-mcp, which builds only on macOS, and Calendar reads through the macOS helper
test.skip(process.platform !== 'darwin', 'MoMo’s tools reach the harness through sage-mcp, which builds only on macOS');

/** Where the fake account service listens: the app reads MOPILOT_API once, at launch, so the port is fixed (one worker runs the specs). */
const API_PORT = 38_473;
const USER = { id: 'user-e2e-core', email: 'momo-core@example.test' };
let api: http.Server;

test.beforeAll(async () => {
  // the account service as far as MoMo's gate reads it: a token refresh, and /api/me with the feature every signed-in account now holds
  api = http.createServer((req, res) => {
    const json = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url?.startsWith('/api/desktop/token'))
      return json({ access_token: 'a'.repeat(32), refresh_token: 'r'.repeat(32), expires_in: 3600 });
    if (req.url?.startsWith('/api/me')) return json({ user: { ...USER, features: ['momo'] }, balanceMicros: 0, shareUsageData: false });
    if (req.url?.startsWith('/v1/models')) return json({ data: [] });
    return json({}, req.method === 'PUT' ? 200 : 404);
  });
  await new Promise<void>((r) => api.listen(API_PORT, '127.0.0.1', r));
});
test.afterAll(() => {
  api?.closeAllConnections();
  api?.close();
});

/** A signed-in account: the sign-in file as an earlier build wrote it (read, and saved again encrypted), as tests/e2e/momo-home-real.spec.ts seeds it. */
const signIn = (userData: string) =>
  fs.writeFileSync(
    `${userData}/mopilot-auth.json`,
    JSON.stringify({
      v: 1,
      enc: 'plain',
      data: Buffer.from(
        JSON.stringify({
          refreshToken: 'r'.repeat(32),
          gatewayKey: 'k'.repeat(32),
          user: { id: USER.id, features: [] },
          deviceId: 'dev-e2e-core',
        }),
      ).toString('base64'),
    }),
  );
/**
 * What the launch ships (#5800): MoMo in the Mac app, with its home on a Host and Outputs off. The e2e preset turns every flag in
 * development on, so they are pinned off here; with momo.home on, MoMo would open on "Where should MoMo live?" instead of its setup.
 */
const LAUNCH_FLAGS = 'momo.home=0,momo.outputs=0';
const ENV = { MOPILOT_API: `http://127.0.0.1:${API_PORT}`, MOPILOT_FLAGS: LAUNCH_FLAGS };

/** Main's answers once the account service was read in this run (checkedAt set), or signed out: what the gate decided from. */
async function settledAccess(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = await (window as any).native.mopilot.status();
          return !s.signedIn || typeof s.checkedAt === 'number';
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  return page.evaluate(() => (window as any).native.momo.access());
}

const FACT = 'Dentist is Dr. Okafor at Bayview Dental; prefers Tuesday mornings';
const EVENT = '[test] Call with Priya about the Q1 budget';

for (const [harnesses, reply] of [
  ['claude', 'fake-claude'],
  ['codex', 'fake-codex'],
] as const) {
  test.describe(`signed in, on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({
      harnesses,
      computerHelper: true,
      env: ENV,
      seed: {
        files: (d) => {
          signIn(d.userData);
          if (harnesses === 'codex') codexCliLogin(d);
        },
      },
    });

    test('the core journey: entry, setup, a turn, a fact saved and recalled, Calendar connected and read', async ({ page, harness }) => {
      test.setTimeout(4 * 60_000);
      // the entry follows the server's answer for this account, not a dev stand-in
      await expect(momoRow(page)).toBeVisible({ timeout: 30_000 });
      expect(await settledAccess(page)).toBe(true);

      // setup (Meet, then Not now on Notifications) ends in MoMo's Chat
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);

      // a turn is answered
      const ask = '[test] What can you help me with today?';
      await send(ask);
      await expect(chat.getByText(momoReply(reply, ask))).toBeVisible({ timeout: 30_000 });

      // a fact is saved through MoMo's own memory tool and shows in Memory › Facts
      await send(`CUCALL momo_memory_save ${JSON.stringify({ text: FACT, confidence: 'sure' })}`);
      await expect(chat.getByText(/Saved to MoMo's memory: "Dentist is Dr\. Okafor/)).toBeVisible({ timeout: 30_000 });
      await goToMomoView(page, 'Memory');
      await expect(settingsGroup(page, 'Facts').getByText(FACT, { exact: true })).toBeVisible();

      // the next turn recalls it: the search's answer carries the saved text, which the message asking did not
      await goToMomoView(page, 'Chat');
      await send('CUCALL momo_memory_search {"query":"dentist"}');
      await expect(chat.getByText(/1 fact from MoMo's memory[\s\S]*Bayview Dental/)).toBeVisible({ timeout: 30_000 });

      // today's Calendar: the read asks to connect, Connect shows macOS's prompt (allowed), the card goes and the event is read
      const now = Date.now();
      harness.helper!.eventkit.onPrompt = 'granted';
      harness.helper!.eventkit.events = [{ title: EVENT, start: now + 3_600_000, end: now + 5_400_000, calendar: 'Work', allDay: false }];
      await send('CUCALL momo_calendar_events {}');
      const card = chat.locator('[data-kind="momoConnect"]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.getByRole('heading')).toHaveText('Connect Calendar?');
      await card.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(card).toHaveCount(0, { timeout: 20_000 });
      await expect(chat.getByText(/Call with Priya about the Q1 budget/)).toBeVisible({ timeout: 30_000 });
      expect(harness.helper!.log.some((l) => l.method === 'eventkit.request' && l.params.entity === 'calendar')).toBe(true);
      await expect(momoChat(page)).toBeVisible();
    });
  });
}

test.describe('signed out', () => {
  test.use({ harnesses: 'claude', env: ENV });

  test('no MoMo row, and main says MoMo is not allowed', async ({ page }) => {
    await expect(page.getByRole('textbox', { name: 'Message', exact: true }).first()).toBeVisible();
    expect(await settledAccess(page)).toBe(false);
    await expect(momoRow(page)).toHaveCount(0);
  });
});

test.describe('signed in with the momo.enabled kill switch off', () => {
  test.use({
    harnesses: 'claude',
    env: { ...ENV, MOPILOT_FLAGS: `${LAUNCH_FLAGS},momo.enabled=0` },
    seed: { files: (d) => signIn(d.userData) },
  });

  test('the server’s answer holds momo, yet no MoMo row shows and main says MoMo is not allowed', async ({ page }) => {
    await expect(page.getByRole('textbox', { name: 'Message', exact: true }).first()).toBeVisible();
    expect(await settledAccess(page)).toBe(false);
    expect(await page.evaluate(async () => (await (window as any).native.mopilot.status()).user?.features)).toContain('momo');
    await expect(momoRow(page)).toHaveCount(0);
  });
});
