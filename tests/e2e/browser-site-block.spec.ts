// #4651: a site that answers the in-app browser with HTTP 403 reaches the agent as a block (the status and one line on what to do), and the
// site is not asked again for a while: the agent's second navigation to it is refused without a request.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';

test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');
// the test site is on 127.0.0.1, which is not paced unless asked (siteBlock.cjs pacedHost)
test.use({ harnesses: 'codex', env: { SAGE_E2E_PACE_LOCAL: '1' } });

let server: http.Server;
let site = '';
let hits = 0;
test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(403, { 'content-type': 'text/html' }).end('<!doctype html><title>Error Page</title><h1>Oops!! Something went wrong</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test('a 403 from a site is a block the agent is told about, and the site is left alone after it', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const calls = [
    `CUCALL browser_navigate ${JSON.stringify({ url: `${site}/p/1` })}`,
    `CUCALL browser_navigate ${JSON.stringify({ url: `${site}/p/2` })}`,
  ];
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(calls.join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const main = page.getByRole('main');
  await expect(async () => {
    const card = page.locator('.sage-approval');
    if (await card.count()) await pickScope(card.first(), /Allow/);
    await expect(main).toContainText('not asked again', { timeout: 2000 });
  }).toPass({ timeout: 90_000 });
  await expect(main).toContainText('answered HTTP 403');
  await expect(main).toContainText('Continue in Chrome');
  // only the first navigation reached the site
  expect(hits).toBe(1);
});
