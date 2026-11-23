// CUJ browser-interruptions across harnesses: what a person does to a built-in browser turn on a messy real-world site
// (2026-10-20 bug bash): a page whose server is slow is loading, never "a script on it is busy" (#1837), a message
// sent while the agent waits on that page runs after it, Stop in the middle of a navigation and going on by message on
// the same tab, the user closing the agent's tab under a call, and the user answering a hand-off by message instead of
// "Done, continue" (#1849: the hand-off ends the turn, and the user's own reply ends the hand-off and goes on).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');
const composerStop = (page: Page) => page.locator('.composer').getByRole('button', { name: 'Stop', exact: true });
const agentBar = (page: Page) => page.locator('.browser-agent-bar');
const expectIdle = (page: Page, timeout?: number) =>
  expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout });
// a fake harness answers an interrupt once its call in flight returns (the real CLIs end the turn at once), so a page
// under a Stop or a closed tab answers within this
const IN_FLIGHT_S = 15;
const UNRESPONSIVE = "isn't responding";

/** How a harness calls the built-in browser tools (#351): Codex the Registry's browser_*, Claude Code its mopilot_browser server. */
interface Way {
  who: 'Codex' | 'Claude Code';
  model: string;
  tool(short: string): string;
  /** a word that makes the fake show each call as a step, so an interrupt ends the turn with the call in flight */
  steps: string;
}
const CODEX: Way = { who: 'Codex', model: 'Fake Model One', tool: (s) => `browser_${s}`, steps: '' };
const CLAUDE: Way = { who: 'Claude Code', model: 'Fake Sonnet', tool: (s) => `mcp__mopilot_browser__${s}`, steps: 'CUSTEPS' };
const call = (w: Way, short: string, args: object = {}) => `CUCALL ${w.tool(short)} ${JSON.stringify(args)}`;

async function newChatOn(page: Page, w: Way) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: w.who }).click();
  await page.locator('.hp-models .menu-item', { hasText: w.model }).click();
  await page.keyboard.press('Escape');
}
async function send(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toContainText(lines[lines.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
/** Records, from now on, whether the "isn't responding" notice ever shows anywhere in the window. */
async function watchUnresponsive(page: Page) {
  await page.evaluate((text) => {
    const w = window as unknown as { __sawUnresponsive?: boolean };
    w.__sawUnresponsive = false;
    new MutationObserver(() => {
      if (document.body.textContent?.includes(text)) w.__sawUnresponsive = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, UNRESPONSIVE);
}
const sawUnresponsive = (page: Page) => page.evaluate(() => !!(window as unknown as { __sawUnresponsive?: boolean }).__sawUnresponsive);

// a site that copies real-world slowness: /slow?s=N answers after N seconds; / is a case lookup form
let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const html = (title: string, body: string) =>
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>${title}</title>${body}`);
    if (u.pathname === '/slow') {
      const s = Number(u.searchParams.get('s') ?? 8);
      const timer = setTimeout(() => html('Slow page', `<h1>Loaded after ${s}s</h1>`), s * 1000);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    if (u.pathname === '/form' && req.method === 'POST') return html('Result', '<h1>Case status: in review</h1>');
    html('Case lookup', '<h1>Case lookup</h1><form method="post" action="/form"><input name="id"><button>Search</button></form>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function journey(page: Page, w: Way) {
  await expect(home(page)).toBeVisible();
  await newChatOn(page, w);

  // 1. a slow page (8 s, past the hang check's 6 s) is loading, not a busy script; a message sent meanwhile waits
  await watchUnresponsive(page);
  await send(page, [call(w, 'navigate', { url: `${site}/slow?s=8` }), call(w, 'get_page_text')]);
  await expect(card(page)).toContainText(`Allow ${w.who} to use ${site}`);
  await pickScope(card(page), /Allow in this chat/);
  await expect(agentBar(page)).toHaveAttribute('data-state', 'active');
  await composer(page).fill('also look up case 42 when the page is up');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // the navigation itself returned with the page (its answer names the page's title), then the page was read
  await expect(transcript(page)).toContainText('(Slow page)', { timeout: 30_000 });
  await expect(transcript(page)).toContainText('Loaded after 8s');
  await expect(transcript(page)).toContainText('also look up case 42');
  await expectIdle(page);
  expect(await sawUnresponsive(page)).toBe(false);

  // 2. Stop in the middle of a navigation, then go on by message on the same tab
  const slowCall = (s: number) => `${w.steps} ${call(w, 'navigate', { url: `${site}/slow?s=${s}` })}`.trim();
  await send(page, [slowCall(IN_FLIGHT_S), call(w, 'get_page_text')]);
  await expect(composerStop(page)).toBeVisible();
  await composerStop(page).click();
  await expectIdle(page, (IN_FLIGHT_S + 15) * 1000);
  await send(page, [call(w, 'navigate', { url: `${site}/` }), call(w, 'get_page_text')]);
  await expect(transcript(page)).toContainText('Case lookup');
  await expectIdle(page);
  expect(await sawUnresponsive(page)).toBe(false);

  // 3. the user closes the agent's tab under a navigation: the turn ends, and the next one opens a tab again
  await send(page, [slowCall(IN_FLIGHT_S), call(w, 'get_page_text')]);
  await expect(agentBar(page)).toHaveAttribute('data-state', 'active');
  await page
    .getByRole('button', { name: /^Close .* tab$/ })
    .first()
    .click();
  await expectIdle(page, (IN_FLIGHT_S + 15) * 1000);
  const lookups = await transcript(page).getByText('Case lookup').count();
  await send(page, [call(w, 'navigate', { url: `${site}/` }), call(w, 'get_page_text')]);
  await expect(transcript(page).getByText('Case lookup')).not.toHaveCount(lookups);
  await expectIdle(page);

  // 4. the agent hands the tab to the user (no password on the page: "Your turn on"), and its turn ends there (#1849)
  const handoff = page.locator('.browser-agent-bar[data-state="handoff"]');
  await send(page, [call(w, 'navigate', { url: `${site}/` }), call(w, 'request_signin', { reason: 'Type the case number' })]);
  await expect(handoff).toBeVisible();
  await expect(handoff).toContainText('Your turn on');
  await expect(transcript(page)).toContainText('Handed ');
  // the tab handed to the user keeps its own Stop on the pane's agent bar; the composer's is gone with the turn
  await expect(composerStop(page)).toHaveCount(0);
  // the user answers in the chat instead of Done, continue: the hand-off ends, and the agent goes on from the tab
  const before = await transcript(page).getByText('Case lookup').count();
  await send(page, ['I typed 42, go on', call(w, 'get_page_text')]);
  await expect(handoff).toHaveCount(0);
  await expect(transcript(page)).toContainText('I typed 42, go on');
  await expect(transcript(page).getByText('Case lookup')).not.toHaveCount(before);
  await expectIdle(page);
  // Done was never clicked: no "Done on <site>" message was sent for the user
  await expect(transcript(page)).not.toContainText(`Done on ${new URL(site).host}`);
}

test.use({ harnesses: 'both' });

test('browser-interruptions on Codex: slow page loads, message mid-turn, Stop then go on, tab closed under a call, a hand-off answered by message', async ({
  page,
}) => {
  await journey(page, CODEX);
});

test('browser-interruptions on Claude Code: slow page loads, message mid-turn, Stop then go on, tab closed under a call, a hand-off answered by message', async ({
  page,
}) => {
  await journey(page, CLAUDE);
});
