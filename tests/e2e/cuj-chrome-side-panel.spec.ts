// CUJ chrome-side-panel on both harnesses, with Google Chrome and MoPilot's real extension (loaded unpacked) against the app: the extension asks through the native host and the app's one Allow pairs it (no code), the install checklist shows Connected; the side panel's first run (consent, intro), its model and permission menus, + / @ menus and sidebar; a chat sent from the panel streams its reply, an approval card is answered in the panel, Stop ends a running turn; and the same chat goes on in the app, both ways.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Locator, Page } from '@playwright/test';
import type { Harness } from './fixtures/app';
import type { ExtensionChrome } from './fixtures/extensionChrome';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const transcript = (page: Page) => page.getByRole('main');

// a page in that Chrome, for the panel's @ list and the chat's tab
let server: http.Server;
let formServer: http.Server;
let site = '';
let formSite = '';
test.beforeAll(async () => {
  const respond: http.RequestListener = (_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Expense form</title><h1>Expenses</h1>');
  server = http.createServer(respond);
  formServer = http.createServer(respond);
  await Promise.all([server, formServer].map((local) => new Promise<void>((r) => local.listen(0, '127.0.0.1', r))));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  formSite = `http://127.0.0.1:${(formServer.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  for (const local of [server, formServer]) {
    local.closeAllConnections();
    local.close();
  }
});

/** The panel's first run: the consent naming the risks, the two-slide intro, then the greeting. */
async function firstRun(panel: Page) {
  await expect(panel.getByRole('heading', { name: 'Before you start' })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('#risks li')).toHaveCount(3);
  await expect(panel.locator('#composer')).toBeHidden();
  await panel.getByRole('button', { name: 'I understand' }).click();
  await expect(panel.locator('#intro-title')).toHaveText('Chat from Chrome');
  await panel.getByRole('button', { name: 'Next' }).click();
  await expect(panel.locator('#intro-title')).toHaveText('A tab group per chat');
  await panel.getByRole('button', { name: 'Let’s go' }).click();
  await expect(panel.locator('.empty-mark')).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Ask anything');
  await expect(panel.locator('#composer')).toBeVisible();
}

/** The model menu's effort pick shows on its button; the permission menu lists its rows and keeps the one checked. */
async function menus(panel: Page) {
  const model = panel.locator('#model');
  await expect(model).toBeVisible({ timeout: 15_000 });
  await model.click();
  const menu = panel.locator('#model-menu');
  await expect(menu.getByRole('menuitemradio').first()).toBeVisible();
  const efforts = menu.locator('#model-rows').locator('xpath=./h4[normalize-space()="Effort"]/following-sibling::*[@role="menuitemradio"]');
  if (await efforts.count()) {
    const last = efforts.last();
    const label = (await last.locator('span').first().textContent())!.trim();
    await last.click();
    await expect(menu).toBeHidden();
    await expect(model).toContainText(label);
  } else await model.click();
  const perm = panel.locator('#perm');
  if (await perm.isVisible()) {
    await perm.click();
    const checked = panel.locator('#perm-menu [role="menuitemradio"][aria-checked="true"]');
    await expect(checked).toHaveCount(1);
    await checked.click();
    await expect(panel.locator('#perm-menu')).toBeHidden();
  }
}

/** + offers a screenshot and files; / lists the harness's commands; @ lists this window's tabs. */
async function composerMenus(panel: Page) {
  const box = panel.getByRole('textbox', { name: 'Message' });
  await panel.getByRole('button', { name: 'Add files and more' }).click();
  await expect(panel.getByRole('menuitem', { name: 'Add a screenshot of this tab' })).toBeVisible();
  await expect(panel.getByRole('menuitem', { name: 'Add files' })).toBeVisible();
  await panel.getByRole('button', { name: 'Add files and more' }).click();
  await expect(panel.locator('#plus-menu')).toBeHidden();

  await box.fill('');
  await box.pressSequentially('/');
  const slash = panel.getByRole('listbox', { name: 'Commands' });
  await expect(slash.getByRole('option').first()).toBeVisible({ timeout: 15_000 });
  await box.press('Escape');
  await expect(slash).toBeHidden();
  await box.fill('');

  await box.pressSequentially('Look at @Expense');
  const mention = panel.getByRole('listbox', { name: 'Tabs and chats' });
  await expect(mention.getByRole('option', { name: /Expense form/ })).toBeVisible({ timeout: 15_000 });
  await mention.getByRole('option', { name: /Expense form/ }).click();
  await expect(box).toHaveValue(/Look at \[Expense form\]\(mopilot-tab:\/\/chrome\?tabId=\d+&url=/);
  await box.fill('');
}

/** Answers a command's card in the panel, on every harness (#2114). */
async function allowCommand(card: Locator) {
  await expect(card).toContainText('Run this command?');
  await card.getByRole('button', { name: 'Allow once' }).click({ timeout: 15_000 });
}

async function sendFromPanel(panel: Page, text: string) {
  const box = panel.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

async function journey(
  page: Page,
  harness: Harness,
  chrome: ExtensionChrome,
  o: { label: string; reply: string; approve: string; chromeTool: (s: string) => string },
) {
  // 1. pairing: the app's one Allow, no code
  const welcome = await pairWithAllow(page, chrome);
  // 2. the side panel beside a web page; its first run
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  const { real, inPanel } = side;
  test.info().annotations.push({ type: 'side panel', description: real ? "Chrome's side panel" : 'sidepanel.html in a tab' });
  // Chrome's own side panel: connected (no state page), its first run up, and the page in front as the chat's tab
  const shown = () =>
    inPanel(`({ connected: document.getElementById('state')?.hidden, consent: document.getElementById('consent')?.hidden === false,
      tab: document.getElementById('tab-title')?.textContent })`);
  await expect.poll(shown, { timeout: 30_000 }).toEqual({ connected: true, consent: true, tab: 'Expense form' });
  const panel = await side.panel();
  await firstRun(panel);
  // Each journey admits one harness; the panel omits a harness choice when there is only one.
  await expect(panel.locator('#model')).toContainText(o.label === 'Codex' ? 'Fake Model One' : 'Fake Opus');
  // 3. the menus a new chat goes with
  await menus(panel);
  await composerMenus(panel);

  // 4. a chat from Chrome: it opens in the panel and asks for approval there. The page in front goes with it as its tab
  // (Chrome's own panel sits beside it; sidepanel.html in a tab is itself in front until the page is brought back)
  await front.bringToFront();
  await expect(panel.locator('#tab-title')).toHaveText('Expense form', { timeout: 15_000 });
  await sendFromPanel(panel, `Check the form ${o.approve}`);
  await expect(panel.locator('#title')).toBeVisible();
  const card = panel.locator('#cards .card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('#progress-text')).toHaveText('Waiting for you');
  await allowCommand(card);
  await expect(panel.locator('#rows .reply').last()).toContainText(new RegExp(`${o.reply}: [\\s\\S]*Check the form ${o.approve}`), {
    timeout: 30_000,
  });
  await expect(panel.locator('#rows .reply').last()).toContainText('[command: ran]');
  await expect(card).toHaveCount(0);
  await expect(panel.locator('#progress-text')).toHaveText('Done');
  // the tab it was sent from shows by its site, never as the line the agent reads (#2329)
  const host = new URL(site).host;
  await expect(panel.locator('#rows .you').first().locator('.tab')).toHaveText(host);
  // (the fake agents echo the whole message they got, the tab line included: only the user's own row is checked)
  await expect(panel.locator('#rows .you').first()).toHaveText(`Check the form ${o.approve}${host}`);

  // 5. a follow-up whose reply streams in, then Stop. What the streamed preview (#live) held is recorded.
  await panel.evaluate(() => {
    const live = document.getElementById('live') as HTMLElement;
    const seen = ((window as any).__liveSeen = [] as string[]);
    new MutationObserver(() => live.textContent && seen.push(live.textContent)).observe(live, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await sendFromPanel(panel, 'Keep going SLOW');
  const stop = panel.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  // the reply shows while its turn still runs, on every harness: streamed (#live) until a read of the chat has it as a
  // row (#2116: Claude Code's transcript has no reply until the turn ends)
  await expect(
    panel
      .locator('#chat .reply')
      .filter({ hasText: new RegExp(`${o.reply}: [\\s\\S]*Keep going`) })
      .last(),
  ).toBeVisible({ timeout: 30_000 });
  const seen = await panel.evaluate(() => (window as any).__liveSeen as string[]);
  test.info().annotations.push({ type: 'streamed preview', description: JSON.stringify(seen.slice(0, 5)) });
  await expect(stop).toBeVisible();
  await expect(panel.locator('#progress-text')).toHaveText('Working…');
  await stop.click();
  await expect(stop).toBeHidden({ timeout: 30_000 });
  // a turn the user stopped is "Stopped", not "Done" (#3046, B2)
  await expect(panel.locator('#progress-text')).toHaveText('Stopped');
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();

  // 6. the sidebar: the chat in Recents; Pin, search, New chat, and the chat opened again from its row
  const sidebar = panel.getByRole('complementary', { name: 'Chats' });
  await panel.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(sidebar).toBeVisible();
  for (const head of ['Projects', 'Scheduled', 'Recents']) await expect(sidebar.getByRole('heading', { name: head })).toBeVisible();
  const row = sidebar.locator('#recents .row-chat').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const title = (await row.locator('.t').textContent())!.trim();
  await sidebar
    .getByRole('button', { name: `More options for ${title}` })
    .first()
    .click();
  await sidebar.getByRole('menuitem', { name: 'Pin' }).click();
  await expect(sidebar.locator('#pinned')).toContainText(title, { timeout: 15_000 });
  await sidebar.getByRole('searchbox', { name: 'Search chats' }).fill('no chat is called this');
  await expect(sidebar.locator('#recents .row-chat')).toHaveCount(0);
  await sidebar.getByRole('searchbox', { name: 'Search chats' }).fill(title);
  await expect(sidebar.locator('#recents .row-chat').first()).toContainText(title);
  await sidebar.getByRole('button', { name: '＋ New chat' }).click();
  await expect(panel.locator('.empty-mark')).toBeVisible();
  await panel.getByRole('button', { name: 'Show sidebar' }).click();
  await sidebar.getByRole('searchbox', { name: 'Search chats' }).fill('');
  await sidebar.locator('#pinned .row-chat', { hasText: title }).click();
  await expect(sidebar).toBeHidden();
  await expect(panel.locator('#rows')).toContainText(`Check the form ${o.approve}`, { timeout: 15_000 });
  await expect(panel.locator('#rows')).toContainText('Keep going SLOW');

  // 7. the same chat in the app: what the panel sent and answered is there, and a message from the app reaches the panel
  await panel.getByRole('button', { name: 'More', exact: true }).click();
  await panel.getByRole('menuitem', { name: 'Open in MoPilot', exact: false }).click();
  await expect(transcript(page)).toContainText(new RegExp(`${o.reply}: [\\s\\S]*Check the form ${o.approve}`), { timeout: 30_000 });
  await expect(transcript(page)).toContainText('Keep going SLOW');
  // the window too: the tab as a chip by its site (#2329)
  await expect(transcript(page).locator('.mention-chip.tab').first()).toHaveText(host);
  await expect(transcript(page).locator('.user-message').first()).not.toContainText('[Chrome tab:');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Back in the app');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page)).toContainText(`${o.reply}: Back in the app`, { timeout: 30_000 });
  await expect(panel.locator('#rows')).toContainText(`${o.reply}: Back in the app`, { timeout: 30_000 });
  void harness;

  // 8. the agent works in this Chrome: its tab joins the chat's tab group, and while it waits for the user's OK the
  // group's title and the tab's icon say so; the cards are answered in the panel, and the group then says done
  // The site-card journey explicitly uses Ask: Auto may already permit an ordinary local page.
  await panel.locator('#perm').click();
  await panel.locator('#perm-menu').getByRole('menuitemradio', { name: 'Ask for approval', exact: false }).click();
  await expect(panel.locator('#perm-menu')).toBeHidden();
  // Admission reuses the current tab: a different local origin is needed to test a new-site card.
  const form = `${formSite}form`;
  await sendFromPanel(panel, `CUCALL ${o.chromeTool('navigate')} ${JSON.stringify({ url: form })}\nFill the form ${o.approve}`);
  const siteCard = panel.locator('#cards .card').filter({ hasText: formSite.replace(/\/$/, '') });
  await expect(siteCard).toBeVisible({ timeout: 30_000 });
  await siteCard.getByRole('button', { name: 'Allow in this chat' }).click();
  const commandCard = panel.locator('#cards .card').filter({ hasNotText: formSite.replace(/\/$/, '') });
  await expect(commandCard).toBeVisible({ timeout: 30_000 });
  const groups = () =>
    welcome.evaluate(async (url) => {
      const c = (globalThis as any).chrome;
      const tabs = await c.tabs.query({});
      const tab = tabs.find((t: any) => t.url === url);
      if (!tab || tab.groupId < 0) return null;
      return (await c.tabGroups.get(tab.groupId)).title as string;
    }, form);
  await expect.poll(groups, { timeout: 30_000 }).toMatch(/^🔔 /);
  // named for the chat, or plainly for the app while it has no title: never for its id ("MoPilot claude:5")
  expect(await groups()).not.toMatch(/\b(claude|codex|acp):/);
  const formTab = chrome.context.pages().find((p) => p.url() === form);
  expect(formTab, 'the agent opened the form in this Chrome').toBeTruthy();
  expect(formTab, 'navigation reuses the panel’s original native tab').toBe(front);
  await expect(formTab!.locator('link[data-mopilot-mark]')).not.toHaveCount(0, { timeout: 15_000 });
  await allowCommand(commandCard);
  await expect(panel.locator('#rows .reply').last()).toContainText('[command: ran]', { timeout: 30_000 });
  await expect(panel.locator('#rows .reply').last()).toContainText('Expense form');
  // the step it took reads as what it did (the fake agents run CUCALL themselves, so it is the command's line) (#2329)
  const commandStep = panel.locator('#rows .step').last();
  await expect(commandStep.locator(':scope > summary')).toHaveText('Ran npm test');
  await expect(commandStep.locator('pre')).toContainText('npm test');
  await expect.poll(groups, { timeout: 30_000 }).toMatch(/^✅ /);

  // The fake harness echoes Markdown through the real transcript and panel renderer.
  // Chrome uses uppercase tagName: lowercase-only DOM fakes hid lists restarting at every item.
  await sendFromPanel(
    panel,
    'Formatting sample\n\n1. First\n\n2. Second\n\n3. Third\n\n| Item | Value |\n| --- | --- |\n| Cancel | Free |',
  );
  const formatted = panel.locator('#rows .reply').last();
  await expect(formatted.locator('ol')).toHaveCount(1, { timeout: 30_000 });
  await expect(formatted.locator('ol > li')).toHaveText(['First', 'Second', 'Third']);
  await expect(formatted.locator('.table table th')).toHaveText(['Item', 'Value']);
  await expect(formatted.locator('.table table td')).toHaveText(['Cancel', 'Free']);
}

// two apps' worth of journey: pairing, the panel, two turns and the app
test.describe.configure({ timeout: 240_000 });

test.describe('Codex', () => {
  test.use({ harnesses: 'codex' });
  test('chrome-side-panel on Codex: Allow pairs, first run, menus, chat with approval, stream, Stop, same chat in the app, its tab group in Chrome', async ({
    page,
    harness,
    launchChrome,
  }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await journey(page, harness, await launchChrome(), {
      label: 'Codex',
      reply: 'fake-codex',
      approve: 'APPROVECMD',
      chromeTool: (t) => `chrome_${t}`,
    });
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude' });
  test('chrome-side-panel on Claude Code: Allow pairs, first run, menus, chat with approval, stream, Stop, same chat in the app, its tab group in Chrome', async ({
    page,
    harness,
    launchChrome,
  }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await journey(page, harness, await launchChrome(), {
      label: 'Claude Code',
      reply: 'fake-claude',
      approve: 'RUNCMD',
      chromeTool: (t) => `mcp__mopilot_chrome__${t}`,
    });
  });
});
