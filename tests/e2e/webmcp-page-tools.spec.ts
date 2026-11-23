// WebMCP in the built-in browser (#3571 G6), in Electron's own Chromium: a page that registers tools through
// document.modelContext publishes them to the agent. The agent hears of them once, reads their schemas, runs an
// ordinary one with no card and changes the page. A tool that deletes asks as a "Delete" button would, and a no runs
// nothing. The E2E fixtures launch with MOPILOT_FLAGS=@dev, so shared.browser.webmcp is on.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');

const PAGE = `<!doctype html><title>Shop</title><p id="count">cart: empty</p><script>
const mc = document.modelContext || navigator.modelContext;
document.title = mc ? 'Shop (WebMCP)' : 'Shop (no WebMCP)';
if (mc) {
  mc.registerTool({ name: 'add_to_cart', description: 'Add an item to the cart by SKU',
    inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
    async execute(input) { document.getElementById('count').textContent = 'cart: ' + input.sku; return 'Added ' + input.sku; } });
  mc.registerTool({ name: 'delete_cart', description: 'Delete everything in the cart',
    execute() { document.getElementById('count').textContent = 'cart: DELETED'; return 'deleted'; } });
}
</script>`;

function localSite() {
  const site = { port: 0 };
  let server: http.Server;
  test.beforeAll(async () => {
    server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    site.port = (server.address() as AddressInfo).port;
  });
  test.afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  return site;
}

async function send(page: Page, lines: string[]) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(lines.join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** What every column checks once its calls ran: discovery, schemas, a run that changed the page, a delete that asked. */
async function journey(page: Page, url: string, call: (tool: string, args: object) => string, who: string) {
  await expect(home(page)).toBeVisible();
  await send(page, [
    call('navigate', { url }),
    call('get_page_text', {}),
    call('page_tools', {}),
    call('page_tool', { name: 'add_to_cart', params: { sku: 'A1' } }),
    call('get_page_text', {}),
    call('page_tool', { name: 'delete_cart' }),
    call('get_page_text', {}),
  ]);
  // the site's own card first, as for any new site
  await expect(card(page)).toContainText(`Allow ${who} to use ${url.replace(/\/$/, '')}`);
  await pickScope(card(page), /Allow in this chat/);
  // a tool that deletes asks as a Delete button would (the ordinary add_to_cart before it ran with no card); a no runs nothing
  await expect(card(page)).toContainText('delete something', { timeout: 30_000 });
  await expect(card(page)).toContainText('run page tool "delete_cart"');
  await card(page).getByRole('button', { name: /Deny/ }).click();
  // the fake harness writes each call's answer into its reply when the turn ends
  await expect(transcript(page)).toContainText('The user did not allow this action (delete something)', { timeout: 30_000 });
  // Electron's Chromium gives the page the API (webPreferences.enableBlinkFeatures), and the agent hears of its tools
  await expect(transcript(page)).toContainText('Shop (WebMCP)');
  await expect(transcript(page)).toContainText('publishes 2 page tools');
  await expect(transcript(page)).toContainText('"add_to_cart": "Add an item to the cart by SKU"');
  // the schemas, framed as page content
  await expect(transcript(page)).toContainText('"required":["sku"]');
  // an ordinary tool ran with no card and changed the page
  await expect(transcript(page)).toContainText('<page_tool_result>');
  await expect(transcript(page)).toContainText('Added A1');
  await expect(transcript(page)).toContainText('cart: A1');
  await expect(transcript(page)).not.toContainText('cart: DELETED');
}

test.describe('Claude', () => {
  test.use({ harnesses: 'claude' });
  const local = localSite();
  test('a page’s WebMCP tools: told, read, run, and a delete asks', async ({ page }) => {
    await journey(
      page,
      `http://127.0.0.1:${local.port}/`,
      (tool, args) => `CUCALL mcp__mopilot_browser__${tool} ${JSON.stringify(args)}`,
      'Claude Code',
    );
  });
});

test.describe('Codex', () => {
  test.use({ harnesses: 'codex' });
  const local = localSite();
  // this Codex defers MCP tools behind its own tool search (G2), so the page tools are called by their Registry names
  test('a page’s WebMCP tools: told, read, run, and a delete asks', async ({ page }) => {
    await journey(page, `http://127.0.0.1:${local.port}/`, (tool, args) => `CUCALL browser_${tool} ${JSON.stringify(args)}`, 'Codex');
  });
});
