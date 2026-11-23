// CUJ browser-ref-reload (#3571, f1-deal-review): a page that reloads itself after an action (a form post that redirects back) must not strand the refs the agent read before it. Both harnesses save the deal, then fill the note by the ref read before the save: it lands, or the result says the action was not performed.
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

interface Way {
  who: 'Codex' | 'Claude Code';
  model: string;
  tool(short: string): string;
}
const CODEX: Way = { who: 'Codex', model: 'Fake Model One', tool: (s) => `browser_${s}` };
const CLAUDE: Way = { who: 'Claude Code', model: 'Fake Sonnet', tool: (s) => `mcp__mopilot_browser__${s}` };
const call = (w: Way, short: string, args: object = {}) => `CUCALL ${w.tool(short)} ${JSON.stringify(args)}`;

// The deal page: Save deal posts and redirects back to the same address (a new document), Add note posts a note.
const notes: string[] = [];
let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const page = () =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>Deal</title><h1>Deal DEAL-1</h1>` +
            `<form method="post" action="/save"><label for="amount">Amount</label><input id="amount" name="amount"><button>Save deal</button></form>` +
            `<form method="post" action="/note"><label for="note">Add note</label><textarea id="note" name="note"></textarea><button>Add note</button></form>` +
            `<ul>${notes.map((n) => `<li>note: ${n}</li>`).join('')}</ul>`,
        );
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/note') notes.push(decodeURIComponent(new URLSearchParams(body).get('note') ?? ''));
        res.writeHead(303, { location: '/' }).end();
      });
      return;
    }
    page();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function newChatOn(page: Page, w: Way) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: w.who }).click();
  await page.locator('.hp-models .menu-item', { hasText: w.model }).click();
  await page.keyboard.press('Escape');
}

test.use({ harnesses: 'both' });

for (const way of [CODEX, CLAUDE]) {
  test(`browser refs: ${way.who} saves the deal, then fills the note by the ref it read before the save`, async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await newChatOn(page, way);
    const text = `reload-note-${way.who === 'Codex' ? 'c' : 'k'}`;
    // the refs navigate's page tree gives this page (the headings and labels take the numbers between): Amount 3, Save deal 4, Add note box 6, Add note button 7
    const lines = [
      call(way, 'navigate', { url: `${site}/` }),
      call(way, 'form_input', { ref: 'ref_3', value: '41000' }),
      call(way, 'computer', { action: 'left_click', ref: 'ref_4' }),
      call(way, 'form_input', { ref: 'ref_6', value: text }),
      call(way, 'computer', { action: 'left_click', ref: 'ref_7' }),
      call(way, 'get_page_text'),
    ];
    await composer(page).fill(lines.join('\n'));
    await expect(composer(page)).toContainText(lines[lines.length - 1]);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(card(page)).toContainText(`Allow ${way.who} to use ${site}`);
    await pickScope(card(page), /Allow in this chat/);
    // the note went in by the old ref, on the reloaded page, and nothing was reported stale
    await expect(transcript(page)).toContainText(`note: ${text}`);
    await expect(transcript(page)).not.toContainText('is stale or not found');
    expect(notes).toContain(text);
  });
}
