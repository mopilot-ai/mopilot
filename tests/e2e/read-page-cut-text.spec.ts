// read_page on a long email (#3571 Codex × IAB, f2-onboarding): a text run cut at the tree's limit says how much it left out
// and names get_page_text, which reads the rest, on Codex and on Claude Code.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const BODY = [
  'Hi Tariq, Jun Yilmaz has signed! Please complete their onboarding application. Details:',
  '- Full name: Jun Yilmaz - Personal email: jun.yilmaz98@homemail.test - Date of birth: 1971-12-13',
  '- Mobile: +351 938 443 137 - Home address: 143 Elm Street, Bergen - Department: Sales',
  '- Start date: the first Monday after 2026-11-21 - Manager: Priya Haddad (copied here)',
  '- Bank account: MG72 6058 4976 5504 - Tax number: 227-115-459 - Passport: see the attached scan',
].join(' ');
const PAGE = `<!doctype html><title>New hire · Mail</title><main><h1>New hire: Jun Yilmaz</h1><div>${BODY}</div></main>`;

let server: http.Server;
let port = 0;
test.beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => server.close());

/** Sends the calls, allows the local site once and checks what the agent read. */
async function readsTheCut(page: Page, calls: string[]) {
  const started = Date.now();
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(calls.join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const approval = page.locator('.sage-approval');
  await expect(approval).toContainText(`127.0.0.1:${port}`);
  await pickScope(approval, /Allow once/);
  const main = page.getByRole('main');
  // the tree's text run is cut and says so; the note names the tool that reads the rest, and that tool does
  await expect(main).toContainText(`${BODY.slice(0, 299)}… [+${BODY.length - 299} chars]`);
  await expect(main).toContainText("get_page_text reads the page's whole text.");
  await expect(main).toContainText('Tax number: 227-115-459');
  console.log(`read-page cut text ${Date.now() - started}ms`);
}

test.describe('Codex', () => {
  test.use({ harnesses: 'codex' });
  test('a cut text run in read_page says what it left out and where to read it', async ({ page }) => {
    const url = `http://127.0.0.1:${port}/`;
    await readsTheCut(page, [
      `CUCALL browser_navigate ${JSON.stringify({ url })}`,
      'CUCALL browser_read_page {"filter":"all"}',
      'CUCALL browser_get_page_text {}',
    ]);
  });
});

test.describe('Claude', () => {
  test.use({ harnesses: 'claude' });
  test('a cut text run in read_page says what it left out and where to read it', async ({ page }) => {
    const url = `http://127.0.0.1:${port}/`;
    await readsTheCut(page, [
      `CUCALL mcp__mopilot_browser__navigate ${JSON.stringify({ url })}`,
      'CUCALL mcp__mopilot_browser__read_page {"filter":"all"}',
      'CUCALL mcp__mopilot_browser__get_page_text {}',
    ]);
  });
});
