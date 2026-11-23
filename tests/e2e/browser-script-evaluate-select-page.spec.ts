// A CRM-like page with a closed account menu, read the way the G12 bench runs read it (#3571): tab.evaluate returns the
// page's value, not null, and the injection screen leaves the page alone, with no mark inside the amount, on Codex and on
// Claude Code.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

// the nav's "New contact" and the account shown above the menu are in one sentence with an option of the closed menu:
// the page the screen flagged in the bench (the options have no box, so they counted as hidden text)
const PAGE = `<!doctype html><title>Deal</title><nav>CRM Accounts Contacts Deals New contact New deal</nav>
<h1>Juniper Goods platform expansion</h1>
<p>Account: Juniper Goods Stage: proposal Amount: $50,800.00 Close date: 2026-11-18</p>
<form><label>Account <select><option value="">Choose an account</option><option>Bluefin Traders</option><option>Bluefin Wholesale</option><option selected>Juniper Goods</option></select></label></form>`;

let server: http.Server;
let port = 0;
test.beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => server.close());

/** Sends the calls and allows every card they raise (the site, then page JavaScript) until the page's values are in the chat. */
async function runs(page: Page, calls: string[]) {
  const started = Date.now();
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(calls.join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const main = page.getByRole('main');
  await expect(async () => {
    const card = page.locator('.sage-approval');
    if (await card.count()) await pickScope(card.first(), /Allow/);
    await expect(main).toContainText('Choose an account', { timeout: 2000 });
  }).toPass({ timeout: 90_000 });
  // tab.evaluate answered with the page's array, not null
  await expect(main).toContainText('"sq": 9');
  // the amount reads whole, and nothing on the page was marked as an instruction to the agent
  await expect(main).toContainText('Amount: $50,800.00');
  await expect(main).not.toContainText('<untrusted');
  await expect(main).not.toContainText('read as instructions to an AI agent');
  console.log(`evaluate and select page ${Date.now() - started}ms`);
}

const code = {
  evaluate: 'return await tab.evaluate(() => [1, 2, 3].map((n) => ({ n, sq: n * n })));',
  text: "return await tab.locator('body').innerText();",
};

test.describe('Codex', () => {
  test.use({ harnesses: 'codex' });
  test('tab.evaluate returns the value and a closed menu does not flag the page', async ({ page }) => {
    const url = `http://127.0.0.1:${port}/`;
    await runs(page, [
      `CUCALL browser_navigate ${JSON.stringify({ url })}`,
      `CUCALL browser_script ${JSON.stringify({ code: code.evaluate })}`,
      `CUCALL browser_script ${JSON.stringify({ code: code.text })}`,
    ]);
  });
});

test.describe('Claude', () => {
  test.use({ harnesses: 'claude' });
  test('tab.evaluate returns the value and a closed menu does not flag the page', async ({ page }) => {
    const url = `http://127.0.0.1:${port}/`;
    await runs(page, [
      `CUCALL mcp__mopilot_browser__navigate ${JSON.stringify({ url })}`,
      `CUCALL mcp__mopilot_browser__browser_script ${JSON.stringify({ code: code.evaluate })}`,
      `CUCALL mcp__mopilot_browser__browser_script ${JSON.stringify({ code: code.text })}`,
    ]);
  });
});
