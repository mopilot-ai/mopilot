// CUJ chrome-panel-b2-progress on Claude Code and Codex, with Google Chrome and MoPilot's real extension (#3046, B2): a turn the
// user stops from the panel reads "Stopped" (a muted dot), not "Done"; the next turn replaces it; "Watching Ns" runs while the turn runs.
// A failed turn ("Failed", red dot) has no fake that fails on both harnesses: its wording and dot are pinned by unit tests only.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Progress page</title><h1>Progress</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.describe.configure({ timeout: 240_000 });
for (const kind of ['claude', 'codex'] as const)
  test.describe(kind, () => {
    test.use({ harnesses: kind });
    test(`chrome-panel-b2-progress on ${kind}: a stopped turn reads "Stopped", the next turn "Done"`, async ({
      page,
      launchChrome,
    }, info) => {
      const chrome = await launchChrome();
      const welcome = await pairWithAllow(page, chrome);
      const front = await chrome.context.newPage();
      await front.goto(site);
      const side = await chrome.sidePanel(welcome, front);
      await completePanelFirstRun(side);
      await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
      await side.inPanel(
        `(() => { const h = document.getElementById('harness'); h.value = ${JSON.stringify(kind)}; h.dispatchEvent(new Event('change')); })()`,
      );
      const send = (text: string) =>
        side.inPanel(
          `(() => { const t = document.getElementById('text'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`,
        );
      const line = () =>
        side.inPanel(`[document.getElementById('progress-text').textContent, document.getElementById('progress-dot').className]`);

      // a turn that keeps running until it is stopped (the fake harness waits for the interrupt)
      await send('Work on this for a while SLOW');
      await expect.poll(line, { timeout: 60_000 }).toEqual(['Working…', 'dot wait']);
      // the elapsed counter runs while it does
      await expect
        .poll(() => side.inPanel(`document.getElementById('elapsed').textContent`), { timeout: 30_000 })
        .toMatch(/^Watching \d+s$/);
      // the panel is opened again six seconds into the turn: it joins a turn it did not see begin, and counts from the turn's own
      // start (MoPilot gave it with the read), not from when it first saw the turn run
      await page.waitForTimeout(6000);
      await side.inPanel(`setTimeout(() => location.reload(), 0)`);
      const text = (id: string) => side.inPanel(`document.getElementById('${id}')?.textContent ?? ''`).catch(() => '');
      await expect.poll(() => text('progress-text'), { timeout: 60_000 }).toBe('Working…');
      await expect
        .poll(() => side.inPanel(`document.getElementById('chat').dataset.turnStart || ''`).catch(() => ''), { timeout: 30_000 })
        .toMatch(/^\d{13}$/);
      await expect.poll(async () => Number((await text('elapsed')).replace(/\D/g, '')), { timeout: 30_000 }).toBeGreaterThanOrEqual(6);
      const start = Number(await side.inPanel(`document.getElementById('chat').dataset.turnStart`));
      const shown = Number((await text('elapsed')).replace(/\D/g, ''));
      const age = (Date.now() - start) / 1000;
      info.annotations.push({
        type: 'turn-start',
        description: `turn began ${age.toFixed(1)}s ago, the reopened panel said Watching ${shown}s`,
      });
      expect(Math.abs(shown - age)).toBeLessThan(4);
      await side.screenshot(info.outputPath('running.png'));

      // Stop: the turn ended because the user ended it
      await expect.poll(() => side.inPanel(`!document.getElementById('stop').hidden`)).toBe(true);
      await side.click('#stop');
      await expect.poll(line, { timeout: 60_000 }).toEqual(['Stopped', 'dot off']);
      expect(await side.inPanel(`document.getElementById('elapsed').textContent`)).toBe('');
      await side.screenshot(info.outputPath('stopped.png'));
      // it stays "Stopped" while the chat is idle (an update that only says idle brings no "Done" back)
      await page.waitForTimeout(2000);
      expect(await line()).toEqual(['Stopped', 'dot off']);

      // the next turn replaces it: running, then done
      await send('Say hello');
      await expect.poll(line, { timeout: 60_000 }).toEqual(['Done', 'dot ok']);
      await side.screenshot(info.outputPath('done.png'));
    });
  });
