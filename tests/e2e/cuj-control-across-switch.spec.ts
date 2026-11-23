// CUJ control-across-switch (the 9-grid's switch column): a chat granted a Mac app (fake computer-use helper) and a site in the built-in browser switches harness mid-task; the next harness uses both with no second card, and Stop still lets go of the app.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { remoteFlags } from './fixtures/flags';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');
/** The composer's status while a turn works in an app ("Working in TextEdit: Captured screen"). */
const working = (page: Page) => page.getByRole('button', { name: /^Working in TextEdit/ });

/** How a harness calls MoPilot's desktop and browser tools (see cuj-background-app-control and cuj-use-my-chrome). */
interface Way {
  who: 'Codex' | 'Claude Code';
  model: string;
  desktop(name: string, args: object): string;
  browser(short: string, args?: object): string;
  /** the last line of a desktop message: the calls show as tool steps */
  steps: string;
}
const CODEX: Way = {
  who: 'Codex',
  model: 'Fake Model One',
  desktop: (name, args) => `MCPCU ${name} ${JSON.stringify(args)}`,
  browser: (s, args = {}) => `CUCALL browser_${s} ${JSON.stringify(args)}`,
  steps: 'go',
};
const CLAUDE: Way = {
  who: 'Claude Code',
  model: 'Fake Sonnet',
  desktop: (name, args) => `CUCALL mcp__mopilot_computer__${name.replace(/^desktop_/, '')} ${JSON.stringify(args)}`,
  browser: (s, args = {}) => `CUCALL mcp__mopilot_browser__${s} ${JSON.stringify(args)}`,
  steps: 'CUSTEPS',
};

async function send(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toContainText(lines[lines.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pick(page: Page, w: Way) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: w.who }).click();
  await page.locator('.hp-models .menu-item', { hasText: w.model }).click();
}
const expectIdle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Fixture</title><h1>Hello from the fixture</h1>'),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function journey(page: Page, first: Way, second: Way) {
  await expect(home(page)).toBeVisible();
  await standaloneNewChat(page).click();
  await pick(page, first);
  await page.keyboard.press('Escape');

  // 1. on the first harness: TextEdit granted for this chat, and the fixture site allowed in this chat
  await send(page, [first.desktop('desktop_request_access', { apps: ['TextEdit'], reason: 'Edit the draft' }), first.steps]);
  await expect(card(page)).toContainText(`Allow ${first.who} to use TextEdit?`);
  await card(page)
    .getByRole('button', { name: /^Allow/ })
    .click();
  await expect(transcript(page).getByText(/"granted": \[\s*\{\s*"app": "TextEdit"/)).toBeVisible();
  await expectIdle(page);
  await send(page, [first.browser('navigate', { url: `${site}/` }), first.browser('get_page_text')]);
  await expect(card(page)).toContainText(`Allow ${first.who} to use ${site}`);
  await pickScope(card(page), /Allow in this chat/);
  await expect(transcript(page)).toContainText('Hello from the fixture');
  await expectIdle(page);

  // 2. switch the chat to the other harness mid-task
  await pick(page, second);
  // the sheet shows only when something in the chat is at risk; otherwise the pick switches at once
  await expect(page.getByText('Next message continues on').or(page.locator('.switch-sheet'))).toBeVisible();
  if (await page.locator('.switch-sheet').isVisible()) await page.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(page.getByText('Next message continues on')).toBeVisible();

  // 3. the next harness works in TextEdit and on the site with the chat's grants: no card for either
  await send(page, [second.desktop('desktop_app_screenshot', { app: 'TextEdit' }), second.steps]);
  // the first reply after a switch carries the whole handoff record, so it takes a while to stream
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
  await expect(
    transcript(page)
      .getByText(/Window 88 "Untitled" of TextEdit/)
      .last(),
  ).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await send(page, [second.browser('navigate', { url: `${site}/` }), second.browser('get_page_text')]);
  await expect(transcript(page).getByText('Hello from the fixture').last()).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expectIdle(page);

  // 4. Stop still lets go of TextEdit on the new harness: the "Working in TextEdit" status goes with the turn
  await send(page, [second.desktop('desktop_app_screenshot', { app: 'TextEdit' }), `${second.steps} SLOW`]);
  await expect(working(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expectIdle(page);
  await expect(working(page)).toHaveCount(0);
}

// the default switches, but not Codex's own computer use (native.codex.enabled), as in cuj-background-app-control
test.use({ harnesses: 'both', computerHelper: true, seed: { files: remoteFlags({ 'native.codex.enabled': false }) } });

test('control-across-switch: Codex to Claude Code keeps the app and site grants; Stop lets go of the app', async ({ page }) => {
  await journey(page, CODEX, CLAUDE);
});

test('control-across-switch: Claude Code to Codex keeps the app and site grants; Stop lets go of the app', async ({ page }) => {
  await journey(page, CLAUDE, CODEX);
});
