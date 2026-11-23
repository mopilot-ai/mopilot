// Replay on a turn (#3571, G5): with "Record turn replays" on, a Codex turn and a Claude Code turn that use the built-in browser each get a Replay in their actions that opens the turn's steps and frames on a scrubber; a turn that used no browser gets none.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const card = (page: Page) => page.locator('.sage-approval');
const replay = (page: Page) => page.getByRole('button', { name: 'Replay', exact: true });

interface Way {
  who: 'Codex' | 'Claude Code';
  model: string;
  tool(short: string): string;
}
const CODEX: Way = { who: 'Codex', model: 'Fake Model One', tool: (s) => `browser_${s}` };
const CLAUDE: Way = { who: 'Claude Code', model: 'Fake Sonnet', tool: (s) => `mcp__mopilot_browser__${s}` };
const call = (w: Way, short: string, args: object = {}) => `CUCALL ${w.tool(short)} ${JSON.stringify(args)}`;

async function newChatOn(page: Page, w: Way) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: w.who }).click();
  await page.locator('.hp-models .menu-item', { hasText: w.model }).click();
  await page.keyboard.press('Escape');
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const expectIdle = (page: Page) => expect(page.locator('button.send-btn.stop')).toHaveCount(0);

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Shop</title><h1>Shop</h1><button onclick="this.textContent=\'Added\'">Add to cart</button>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.use({ harnesses: 'both', seed: { uiState: { prefs: { browserTurnTrace: true } } } });

test('turn replay: a browser turn on Codex and on Claude Code each get a Replay with its steps and frames', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  for (const w of [CODEX, CLAUDE]) {
    await newChatOn(page, w);
    // a turn with no browser step has no Replay
    await send(page, 'hello');
    await expectIdle(page);
    await expect(replay(page)).toHaveCount(0);
    await send(
      page,
      [call(w, 'navigate', { url: `${site}/` }), call(w, 'find', { query: 'Add to cart' }), call(w, 'read_page')].join('\n'),
    );
    await expect(card(page)).toContainText(`Allow ${w.who} to use ${site}`);
    await pickScope(card(page), /Allow in this chat/);
    await expectIdle(page);
    // the trace is saved at the turn's end and the button appears on that turn
    await expect(replay(page)).toHaveCount(1, { timeout: 15_000 });
    await replay(page).click();
    const dialog = page.locator('.dialog', { hasText: 'Replay' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('slider', { name: 'Frame' })).toBeVisible();
    const steps = dialog.locator('ol button');
    await expect(steps.first()).toContainText('Opened');
    expect(await steps.count()).toBeGreaterThanOrEqual(3);
    // a step moves the scrubber to its frame (which step a frame marks depends on when the pane painted)
    await steps.nth(2).click();
    await expect(dialog).toContainText(/\d+\/\d+/);
    await expect(dialog).toContainText(/requests · \d+ console/);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  }
});

// #3752: an explicit browser_record that starts and stops mid-turn leaves the turn's trace working (its steps all kept)
test('turn replay: a browser_record that stopped mid-turn leaves every step of the turn in its Replay', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  for (const w of [CODEX, CLAUDE]) {
    await newChatOn(page, w);
    await send(
      page,
      [
        call(w, 'navigate', { url: `${site}/` }),
        call(w, 'record', { action: 'start' }),
        call(w, 'record', { action: 'stop' }),
        call(w, 'navigate', { url: `${site}/two` }),
        call(w, 'navigate', { url: `${site}/three` }),
      ].join('\n'),
    );
    await expect(card(page)).toContainText(`Allow ${w.who} to use ${site}`);
    await pickScope(card(page), /Allow in this chat/);
    await expectIdle(page);
    await expect(replay(page).last()).toBeVisible({ timeout: 15_000 });
    await replay(page).last().click();
    const dialog = page.locator('.dialog', { hasText: 'Replay' });
    const steps = dialog.locator('ol button');
    await expect(steps).toHaveCount(5);
    // the runner's pane paints no frames, so the frame-level check is the UT's (tests/screencastLease.test.ts); here every step of the turn is kept
    await expect(steps.nth(4)).toContainText('Opened');
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
});
