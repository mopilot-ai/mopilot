// #4651: the in-app browser presents the identity of the Chrome it embeds, as a person's Chrome does: a user agent and client hints with no
// Electron or app token, the browser's own languages, and no automation flag beyond what is true. A page served on 127.0.0.1 reports the request
// headers it received and what the page itself can read; the agent reads it back through browser_get_page_text.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';

test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');
test.use({ harnesses: 'codex' });

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const h = req.headers;
    const sent = {
      'user-agent': h['user-agent'],
      'sec-ch-ua': h['sec-ch-ua'],
      'sec-ch-ua-platform': h['sec-ch-ua-platform'],
      'sec-ch-ua-mobile': h['sec-ch-ua-mobile'],
      'accept-language': h['accept-language'],
    };
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Identity</title><h1>Identity</h1><pre id="o"></pre>
<script>
const brands = navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version).join(', ') : 'none';
document.getElementById('o').textContent = 'WEBDRIVER=' + navigator.webdriver + '\\nLANGS=' + navigator.languages.join(',') + '\\nPAGE_BRANDS=' + brands + '\\nSENT=' + ${JSON.stringify(JSON.stringify(sent))} + '\\nPAGE_UA=' + navigator.userAgent;
</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test('the in-app browser sends the embedded Chrome’s identity, with no Electron or app token', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill([`CUCALL browser_navigate ${JSON.stringify({ url: site })}`, 'CUCALL browser_get_page_text {}'].join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const main = page.getByRole('main');
  await expect(async () => {
    const card = page.locator('.sage-approval');
    if (await card.count()) await pickScope(card.first(), /Allow/);
    await expect(main).toContainText('PAGE_UA=', { timeout: 2000 });
  }).toPass({ timeout: 90_000 });
  const read = (await main.innerText()).replace(/\s+/g, ' ');
  console.log(`IDENTITY ${read.slice(read.indexOf('WEBDRIVER='), read.indexOf('WEBDRIVER=') + 1100)}`);
  const seen = read.slice(read.indexOf('WEBDRIVER='));
  console.log(`BRANDS ${read.slice(read.indexOf('PAGE_BRANDS='), read.indexOf('PAGE_BRANDS=') + 200)}`);
  expect(seen).not.toMatch(/Electron/i);
  expect(seen).not.toMatch(/mopilot|sage/i);
  expect(seen).toMatch(/Chrome\/\d+/);
  // the real version of this build, in the header the site gets and in the client hints of the page, never another
  const major = (await harness.app.evaluate(() => process.versions.chrome)).split('.')[0];
  expect(seen.match(/Chrome\/(\d+)/g)).toEqual([`Chrome/${major}`]);
  expect(seen).toContain(`Chromium/${major}`);
  // navigator.webdriver is not asserted: the E2E launches Electron with a remote-debugging port, which sets it; the shipped app has none, and
  // nothing here patches it (the boundary in electron/capabilities/browser/honestIdentity.cjs)
});
