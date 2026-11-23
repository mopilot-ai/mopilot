// CUJ chrome-panel-b4-rendering on Codex and Claude Code, with Google Chrome and MoPilot's real extension (#3046, batch B4): an assistant reply
// in the side panel draws headings at their sizes, nested lists, a quote and images, as Markdown while it streams (what the read draws changes nothing),
// and a Retry sits beside the last reply's Copy and sends the message again without touching the box. The fake agent echoes the message it is sent.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';
import { submitNativePanel } from './fixtures/nativePanelSend.mjs';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Rendering page</title><h1>Rendering</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.describe.configure({ timeout: 300_000 });

// a solid red PNG, 800x8: wider than any panel, so the image has to shrink to fit
const BAR =
  'iVBORw0KGgoAAAANSUhEUgAAAyAAAAAICAIAAACOBQz5AAAARElEQVR4nO3WQQkAMAzAwMqpfxWTNROBwTg4AXlmzi4AAKF5XgAA8BmDBQAQM1gAADGDBQAQM1gAADGDBQAQM1gAALELartZlqoC7UcAAAAASUVORK5CYII=';
const MARKDOWN = [
  'Rendering',
  '# Big heading',
  '## Second heading',
  '### Third heading',
  'Body with `code` and **bold**.',
  '- outer\n  - inner\n    - deepest\n- sibling',
  '> a quote\n> second line',
].join('\n\n');
const PICTURES = `Pictures SLOW\n\n![Tiny red bar](data:image/png;base64,${BAR})\n\n![Remote cat](https://img.invalid/cat.png)`;

for (const kind of ['codex', 'claude'] as const)
  test.describe(kind, () => {
    test.use({ harnesses: kind });
    test(`chrome-panel-b4-rendering on ${kind}: sized headings, nested lists, a quote, images, Markdown while streaming, and Retry`, async ({
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
      const send = (text: string) => submitNativePanel(side, text);

      // what #live shows while the reply streams: its shape, its height, and whether it already holds the heading
      await side.inPanel(`(() => {
        const live = document.getElementById('live');
        globalThis.__sig = (root) => [...root.querySelectorAll('*')].filter((e) => !e.classList.contains('message-copy')).map((e) => e.tagName + '.' + e.className + '@' + (e.getAttribute('aria-level') ?? '')).join(' ');
        globalThis.__live = [];
        new MutationObserver(() => {
          if (!live.hidden) globalThis.__live.push({ length: live.textContent.length, sig: globalThis.__sig(live), height: live.getBoundingClientRect().height, heading: !!live.querySelector('.h[aria-level="1"]') });
        }).observe(live, { childList: true, subtree: true, attributes: true });
      })()`);
      await send(MARKDOWN);
      await expect.poll(() => side.inPanel(`document.querySelectorAll('#rows .reply ul ul ul li').length`), { timeout: 90_000 }).toBe(1);
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 30_000 }).toBe('Done');
      await expect.poll(() => side.inPanel(`document.getElementById('live').hidden`), { timeout: 30_000 }).toBe(true);

      const rendered = await side.inPanel(`(() => {
        const row = [...document.querySelectorAll('#rows .reply')].at(-1);
        const cs = (el) => getComputedStyle(el);
        const left = (el) => el.getBoundingClientRect().left;
        const level = (n) => { const h = row.querySelector('.h[aria-level="' + n + '"]'); return { text: h.textContent, role: h.getAttribute('role'), size: cs(h).fontSize, weight: cs(h).fontWeight, marginTop: cs(h).marginTop }; };
        const body = [...row.querySelectorAll('p:not(.h)')].find((p) => p.textContent.startsWith('Body with'));
        const quote = row.querySelector('blockquote');
        const chat = document.getElementById('chat');
        return {
          h1: level(1), h2: level(2), h3: level(3),
          body: { size: cs(body).fontSize, lineHeight: cs(body).lineHeight, code: !!body.querySelector('code'), strong: !!body.querySelector('strong') },
          list: { padding: cs(row.querySelector('ul')).paddingLeft, siblingGap: cs(row.querySelector('ul > li + li')).marginTop, innerIndent: left(row.querySelector('ul ul > li')) - left(row.querySelector('ul > li')), deepestIndent: left(row.querySelector('ul ul ul > li')) - left(row.querySelector('ul ul > li')) },
          quote: { text: quote.textContent, borderWidth: cs(quote).borderLeftWidth, borderStyle: cs(quote).borderLeftStyle, padding: cs(quote).paddingLeft },
          noOverflow: chat.scrollWidth <= chat.clientWidth && document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        };
      })()`);
      expect(rendered.h1).toEqual({ text: 'Big heading', role: 'heading', size: '20px', weight: '700', marginTop: '8px' });
      expect(rendered.h2).toEqual({ text: 'Second heading', role: 'heading', size: '17px', weight: '700', marginTop: '8px' });
      expect(rendered.h3).toEqual({ text: 'Third heading', role: 'heading', size: '14px', weight: '700', marginTop: '8px' });
      expect(rendered.body).toEqual({ size: '14px', lineHeight: '26.4px', code: true, strong: true });
      expect(rendered.list.padding).toBe('28px');
      expect(rendered.list.siblingGap).toBe('10px');
      // each depth sits one list indent (28px) further in
      expect(rendered.list.innerIndent).toBeGreaterThanOrEqual(27);
      expect(rendered.list.deepestIndent).toBeGreaterThanOrEqual(27);
      expect(rendered.quote.text).toContain('a quote');
      expect(rendered.quote.text).toContain('second line');
      expect([rendered.quote.borderWidth, rendered.quote.borderStyle, rendered.quote.padding]).toEqual(['2px', 'solid', '8px']);
      expect(rendered.noOverflow).toBe(true);
      await side.screenshot(info.outputPath('rendered.png'));

      // Markdown from the first words of the stream: the heading was a heading while it streamed, never raw "# Big heading" after it closed
      const streamed = await side.inPanel(`(() => {
        const row = [...document.querySelectorAll('#rows .reply')].at(-1);
        const fullest = globalThis.__live.reduce((a, b) => (b.length >= (a?.length ?? -1) ? b : a), null);
        return { snapshots: globalThis.__live.length, headed: globalThis.__live.some((s) => s.heading), fullest, rowSig: globalThis.__sig(row), rowHeight: row.getBoundingClientRect().height };
      })()`);
      // Claude Code's history holds a reply only once it is whole, so the live reply is all of it up to the read: the read then moves nothing.
      // Codex's history holds the reply as it is written, so a read mid-stream splits it between the rows and the live reply by design.
      if (kind === 'claude') {
        expect(streamed.snapshots).toBeGreaterThan(0);
        expect(streamed.headed).toBe(true);
        expect(streamed.fullest.sig).toBe(streamed.rowSig);
        expect(Math.abs(streamed.fullest.height - streamed.rowHeight)).toBeLessThanOrEqual(3);
      }

      // Retry: beside Copy (same line, to its right), the only one, and it sends the message again while a draft in the box stays
      const placed = await side.inPanel(`(() => {
        const row = [...document.querySelectorAll('#rows .reply')].at(-1);
        const retry = row.querySelector('.message-retry');
        const copy = row.querySelector('.message-copy:not(.message-retry)');
        const a = copy.getBoundingClientRect();
        const b = retry.getBoundingClientRect();
        return { count: document.querySelectorAll('.message-retry').length, disabled: retry.disabled, label: getComputedStyle(retry, '::before').content, sameLine: Math.abs(a.top - b.top) < 2, toTheRight: b.left >= a.right, copyBlock: getComputedStyle(copy).display };
      })()`);
      expect(placed).toEqual({ count: 1, disabled: false, label: '"Retry"', sameLine: true, toTheRight: true, copyBlock: 'block' });
      await side.inPanel(
        `(() => { const t = document.getElementById('text'); t.value = 'my draft'; t.dispatchEvent(new Event('input')); })()`,
      );
      await side.click('#rows .reply .message-retry');
      await expect.poll(() => side.inPanel(`document.querySelectorAll('#rows .you').length`), { timeout: 30_000 }).toBe(2);
      await expect.poll(() => side.inPanel(`document.querySelectorAll('#rows .reply').length`), { timeout: 90_000 }).toBe(2);
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 30_000 }).toBe('Done');
      const again = await side.inPanel(`(() => {
        const rows = [...document.querySelectorAll('#rows .you')].map((e) => e.textContent.replace('Copy', ''));
        const last = [...document.querySelectorAll('#rows .reply')].at(-1);
        return { same: rows[0] === rows[1], draft: document.getElementById('text').value, retries: document.querySelectorAll('.message-retry').length, inLast: last.contains(document.querySelector('.message-retry')) };
      })()`);
      expect(again).toEqual({ same: true, draft: 'my draft', retries: 1, inLast: true });
      await side.screenshot(info.outputPath('retried.png'));

      // images: a data: raster is drawn and fits; an https: one waits for a click and asks the network for nothing before it
      await send(PICTURES);
      // (in the live reply or, on Codex, whose history holds a reply as it is written, in its row: either draws it the same)
      await expect
        .poll(() => side.inPanel(`document.querySelectorAll('#chat img[alt="Tiny red bar"]').length`), { timeout: 90_000 })
        .toBe(1);
      await expect
        .poll(() =>
          side.inPanel(
            `document.querySelector('#chat img[alt="Tiny red bar"]').complete && document.querySelector('#chat img[alt="Tiny red bar"]').naturalWidth`,
          ),
        )
        .toBe(800);
      const pictures = await side.inPanel(`(() => {
        const bar = document.querySelector('#chat img[alt="Tiny red bar"]');
        const ask = document.querySelector('#chat .img-load');
        const chat = document.getElementById('chat');
        const retry = document.querySelector('.message-retry');
        return {
          fits: bar.getBoundingClientRect().width <= bar.closest('.reply').clientWidth && bar.getBoundingClientRect().width > 0,
          maxWidth: getComputedStyle(bar).maxWidth,
          ask: ask && { text: ask.textContent, title: ask.title },
          remote: [...document.images].filter((i) => i.src.startsWith('https://img.invalid')).length,
          noRetryWhileRunning: !retry || retry.disabled,
          noOverflow: chat.scrollWidth <= chat.clientWidth,
        };
      })()`);
      expect(pictures).toEqual({
        fits: true,
        maxWidth: '100%',
        ask: { text: 'Show image: Remote cat', title: 'Loads from img.invalid' },
        remote: 0,
        noRetryWhileRunning: true,
        noOverflow: true,
      });
      await side.screenshot(info.outputPath('images.png'));
      await side.click('#chat .img-load');
      await expect.poll(() => side.inPanel(`document.querySelectorAll('#chat img[alt="Remote cat"]').length`)).toBe(1);
      expect(await side.inPanel(`document.querySelector('#chat img[alt="Remote cat"]').getAttribute('referrerpolicy')`)).toBe(
        'no-referrer',
      );
      await side.click('#stop');
      // a turn the user stopped reads "Stopped" (B2), not "Done"
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 30_000 }).toBe('Stopped');
      expect(await side.inPanel(`document.getElementById('chat').scrollWidth <= document.getElementById('chat').clientWidth`)).toBe(true);
    });
  });
