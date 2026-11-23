// CUJ built-in-browser across harnesses: an agent opens a site in the built-in browser and hands the tab to the user to sign in (the turn ends; Done, continue starts the next), a chat on the other harness finds that sign-in kept, and Take over pauses the agent on the tab and keeps it open after the turn.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { builtinBrowserPages, test, expect, type Harness } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');
const agentBar = (page: Page) => page.locator('.browser-agent-bar');

/** How a harness calls the built-in browser tools (#351): Codex the Registry's browser_*, Claude Code its mopilot_browser server. */
interface Way {
  who: 'Codex' | 'Claude Code';
  model: string;
  tool(short: string): string;
}
const CODEX: Way = { who: 'Codex', model: 'Fake Model One', tool: (s) => `browser_${s}` };
const CLAUDE: Way = { who: 'Claude Code', model: 'Fake Sonnet', tool: (s) => `mcp__mopilot_browser__${s}` };
const call = (w: Way, short: string, args: object = {}) => `CUCALL ${w.tool(short)} ${JSON.stringify(args)}`;

/** A new chat on that harness: its pick in the model menu. */
async function newChatOn(page: Page, w: Way) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: w.who }).click();
  await page.locator('.hp-models .menu-item', { hasText: w.model }).click();
  await page.keyboard.press('Escape');
}
/** Several CUCALL lines, run in order in one turn (a tab the agent opened closes when its turn ends). */
async function sendCalls(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toContainText(lines[lines.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
// the composer's Stop: a tab handed to the user keeps its own Stop on the pane's agent bar after the turn ends (#1834)
const expectIdle = (page: Page) => expect(page.locator('button.send-btn.stop')).toHaveCount(0);

// "/" asks to sign in until the browser has the session cookie that /login sets
let server: http.Server;
let site = '';
let other = '';
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/login') return res.writeHead(302, { location: '/', 'set-cookie': 'sid=fixture-user; Path=/; HttpOnly' }).end();
    const signedIn = /(?:^|; )sid=fixture-user/.test(req.headers.cookie ?? '');
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        signedIn
          ? '<!doctype html><title>Account</title><h1>Signed in as fixture-user</h1>'
          : '<!doctype html><title>Sign in</title><h1>Please sign in</h1><a href="/login">Sign in</a>',
      );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  site = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** What the user does in the tab while it is theirs: follows the page's sign-in link (the tab is in the persist:browser partition). */
async function userSignsIn(h: Harness) {
  await h.app.evaluate(async ({ webContents, session }, url) => {
    const tab = webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.session === session.fromPartition('persist:browser') && w.getURL().startsWith(url));
    if (!tab) throw new Error(`no built-in browser tab on ${url}`);
    await tab.loadURL(`${url}/login`);
  }, site);
}

async function journey(page: Page, harness: Harness, first: Way, second: Way) {
  await expect(home(page)).toBeVisible();

  // 1. the agent opens the site and hands the tab over to sign in; the site card comes first
  await newChatOn(page, first);
  await sendCalls(page, [
    call(first, 'navigate', { url: `${site}/` }),
    call(first, 'request_signin', { reason: 'Sign in to the fixture site' }),
  ]);
  await expect(card(page)).toContainText(`Allow ${first.who} to use ${site}`);
  await pickScope(card(page), /Allow in this chat/);
  // the tab is the user's now: the pane says so, and the agent's turn ends (#1834); the page has no password field
  await expect(agentBar(page)).toHaveAttribute('data-state', 'handoff');
  await expect(agentBar(page)).toContainText('Your turn on');
  await expect(transcript(page)).toContainText('Handed ');
  await expectIdle(page);
  await userSignsIn(harness);
  // Done sends "Done on <site>" as the user's message, which starts the next turn
  await agentBar(page).getByRole('button', { name: 'Done, continue' }).click();
  await expect(transcript(page)).toContainText(`Done on ${new URL(site).host}`);
  await expectIdle(page);
  // the agent goes on from the page as the user left it
  await sendCalls(page, [call(first, 'get_page_text')]);
  await expect(transcript(page)).toContainText('Signed in as fixture-user');
  await expectIdle(page);

  // 2. a chat on the other harness finds the sign-in kept: one browser profile for every chat and harness
  await newChatOn(page, second);
  await sendCalls(page, [call(second, 'navigate', { url: `${site}/` }), call(second, 'get_page_text')]);
  // a local server is allowed per chat, never for good, so this chat asks for it again
  await expect(card(page)).toContainText(`Allow ${second.who} to use ${site}`);
  await pickScope(card(page), /Allow in this chat/);
  await expect(transcript(page)).toContainText('Signed in as fixture-user');
  await expect(transcript(page)).not.toContainText('Please sign in');
  await expectIdle(page);

  // 3. Take over: while the agent waits on another site's card, the user takes the tab; the agent's next call on it
  // is refused with the reason, and the tab stays open for the user after the turn
  await sendCalls(page, [
    call(second, 'navigate', { url: `${site}/` }),
    call(second, 'navigate', { url: `${other}/` }),
    call(second, 'get_page_text'),
  ]);
  await expect(card(page)).toContainText(`Allow ${second.who} to use ${other}`);
  await expect(agentBar(page)).toHaveAttribute('data-state', 'active');
  await agentBar(page).getByRole('button', { name: 'Take over' }).click();
  await expect(agentBar(page)).toHaveAttribute('data-state', 'takeover');
  await expect(agentBar(page)).toContainText('You took over this tab');
  await card(page).getByRole('button', { name: /Deny/ }).click();
  await expect(transcript(page)).toContainText('took over');
  await expectIdle(page);
  expect(await builtinBrowserPages(harness)).toBeGreaterThan(0);
}

test.use({ harnesses: 'both' });

test('built-in-browser: Codex hands the tab over to sign in, Claude Code finds the sign-in kept, Take over keeps the tab', async ({
  page,
  harness,
}) => {
  await journey(page, harness, CODEX, CLAUDE);
});

test('built-in-browser: Claude Code hands the tab over to sign in, Codex finds the sign-in kept, Take over keeps the tab', async ({
  page,
  harness,
}) => {
  await journey(page, harness, CLAUDE, CODEX);
});
