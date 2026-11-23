// CUJ chrome-panel-b8-dark-mode on Claude Code, with Google Chrome and MoPilot's real extension (#3046): the side panel in the dark scheme (emulated over CDP, as a user's `prefers-color-scheme: dark`)
// draws the app's own dark palette (docs/chrome-panel-parity/design.md section 6): the page, the composer card, a reply with Markdown and code, a
// multi-step turn with its approval card, a menu, the sidebar and a failed send's banners. The same views are read again in light, and both are saved as screenshots.
//
// Colours are read as Chrome computes them (getComputedStyle), so they are what is painted, not what the stylesheet says. Reads are soft: one wrong colour does not hide the others or the screenshots.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';
import { submitNativePanel } from './fixtures/nativePanelSend.mjs';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let other: http.Server;
let site = '';
let otherSite = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Dark page</title><h1>Dark</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  // a site the tab is not on: going there is what needs the user's OK, so an approval card shows
  other = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Other dark page</title><h1>Other</h1>'),
  );
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  otherSite = `http://127.0.0.1:${(other.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
  other.closeAllConnections();
  other.close();
});

test.describe.configure({ timeout: 420_000 });
test.use({ harnesses: 'claude' });

const FOLLOW_UP = 'Follow-up after the connection dropped';
const MARKDOWN = [
  'Dark rendering',
  '# Big heading',
  'Body with `inline code`, **bold** and a [link](https://example.com/dark).',
  '> a quote\n> second line',
  '```\nconst dark = true;\n```',
  '| Surface | Value |\n| --- | --- |\n| page | #171a21 |\n| text | #eef1f6 |',
].join('\n\n');

// the colours Chrome computes for the dark values (docs/chrome-panel-parity/design.md section 6)
const LINE = 'rgba(255, 255, 255, 0.1)';
const LINE_STRONG = 'rgba(255, 255, 255, 0.2)';
const PAGE = 'rgb(23, 26, 33)';
const CARD = 'rgb(34, 37, 44)';
const TEXT = 'rgb(238, 241, 246)';
const MUTED = 'rgb(168, 173, 183)';

test('chrome-panel-b8-dark-mode on Claude Code: the panel draws the app’s dark palette, readable, and light reads the app’s light palette', async ({
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
  const tabId = await welcome.evaluate(
    async (url) => (await (globalThis as any).chrome.tabs.query({})).find((t: any) => t.url === url).id,
    site,
  );

  // the machine's own settings must not decide what is read: the scheme is emulated, and motion is off so no colour is mid-animation
  const scheme = async (value: 'dark' | 'light') => {
    await side.emulateMedia([
      { name: 'prefers-color-scheme', value },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);
    // the panel is hidden while the app window covers Chrome, and a hidden page paints nothing to read or capture
    await front.bringToFront();
  };
  await side.inPanel(`(() => {
    globalThis.__css = (target, prop, pseudo) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      return el ? getComputedStyle(el, pseudo)[prop] : null;
    };
    globalThis.__last = (selector) => [...document.querySelectorAll(selector)].at(-1);
  })()`);
  const css = (target: string, prop: string, pseudo?: string): Promise<string | null> =>
    side.inPanel(`__css(${JSON.stringify(target)}, ${JSON.stringify(prop)}, ${pseudo ? JSON.stringify(pseudo) : 'undefined'})`);
  const last = (selector: string, prop: string, pseudo?: string): Promise<string | null> =>
    side.inPanel(`__css(__last(${JSON.stringify(selector)}), ${JSON.stringify(prop)}, ${pseudo ? JSON.stringify(pseudo) : 'undefined'})`);
  const same = (what: string, actual: unknown, expected: unknown) => expect.soft(actual, what).toBe(expected);
  const has = (what: string, actual: string | null, part: string | RegExp) =>
    typeof part === 'string' ? expect.soft(actual, what).toContain(part) : expect.soft(actual, what).toMatch(part);
  const send = (text: string) => submitNativePanel(side, text);
  const done = () =>
    expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 90_000 }).toBe('Done');
  await side.inPanel(
    `(() => { const h = document.getElementById('harness'); h.value = 'claude'; h.dispatchEvent(new Event('change')); })()`,
  );

  // 1. the empty panel: page, text, the toolbar hairline, the composer card with its ring, the placeholder and a disabled Send
  await scheme('dark');
  same('dark scheme is on', await side.inPanel(`matchMedia('(prefers-color-scheme: dark)').matches`), true);
  same('page', await css('body', 'backgroundColor'), PAGE);
  same('text', await css('body', 'color'), TEXT);
  same('toolbar hairline', await css('.bar', 'borderBottomColor'), LINE);
  same('composer card', await css('.composer-card', 'backgroundColor'), CARD);
  has('composer ring is the hairline', await css('.composer-card', 'boxShadow'), LINE);
  same('typed text', await css('#text', 'color'), TEXT);
  const nativePlaceholder = await css('#text', 'color', '::placeholder');
  if (nativePlaceholder === 'rgba(0, 0, 0, 0)') {
    // The carousel hides the native placeholder; check that its replacement is painted, then read its color.
    const visibleTip = () =>
      side.inPanel(`(() => {
        const tip = document.getElementById('tip');
        if (!tip || tip.hidden || !tip.textContent.trim()) return false;
        const rect = tip.getBoundingClientRect();
        return tip.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && rect.width > 0 && rect.height > 0;
      })()`);
    await expect.poll(visibleTip).toBe(true);
    // A hidden parent must not pass merely because the tip keeps its own opacity and geometry.
    const previousOpacity = await side.inPanel<string>(`(() => {
      const parent = document.getElementById('tip').parentElement;
      const previous = parent.style.opacity;
      parent.style.opacity = '0';
      return previous;
    })()`);
    try {
      expect(await visibleTip(), 'an invisible ancestor hides the placeholder').toBe(false);
    } finally {
      await side.inPanel(`document.getElementById('tip').parentElement.style.opacity = ${JSON.stringify(previousOpacity)}`);
    }
    await expect.poll(visibleTip).toBe(true);
    same('placeholder is the muted text', await css('#tip', 'color'), MUTED);
  } else {
    same('placeholder is the muted text', nativePlaceholder, MUTED);
  }
  same('Send fill', await css('#send', 'backgroundColor'), 'rgb(236, 236, 236)');
  same('a disabled Send is 50%', await css('#send', 'opacity'), '0.5');
  await side.screenshot(info.outputPath('empty-dark.png'));

  // 2. a reply with Markdown and code, after the user's own bubble
  await send(MARKDOWN);
  await expect.poll(() => side.inPanel(`document.querySelectorAll('#rows .reply table').length`), { timeout: 90_000 }).toBe(1);
  await done();
  await front.bringToFront();
  same('user bubble is the raised surface', await last('#rows .you', 'backgroundColor'), CARD);
  same('user bubble text', await last('#rows .you', 'color'), TEXT);
  same('reply text', await last('#rows .reply', 'color'), TEXT);
  same('link keeps the text colour', await last('#rows .reply a', 'color'), TEXT);
  same('link is underlined', await last('#rows .reply a', 'textDecorationLine'), 'underline');
  same('inline code keeps the text colour', await last('#rows .reply p code', 'color'), TEXT);
  same('inline code fill is white at 6%', await last('#rows .reply p code', 'backgroundColor'), 'rgba(255, 255, 255, 0.06)');
  same('code block fill', await last('#rows .reply pre', 'backgroundColor'), CARD);
  same('code in a block keeps the reply’s text colour', await last('#rows .reply pre code', 'color'), TEXT);
  same('quote rule', await last('#rows .reply blockquote', 'borderLeftColor'), LINE);
  same('table header fill', await last('#rows .reply th', 'backgroundColor'), CARD);
  same('table header text', await last('#rows .reply th', 'color'), TEXT);
  same('table cell border', await last('#rows .reply td', 'borderTopColor'), LINE);
  same('Copy under the reply is muted', await last('#rows .reply .message-copy', 'color'), MUTED);
  await side.inPanel(`__last('#rows .reply').scrollIntoView({ block: 'start' })`);
  await side.screenshot(info.outputPath('markdown-dark.png'));

  // 3. a menu: its fill, border and shadow (the permission menu; picking "Ask for approval" next makes the steps wait for a card)
  await expect.poll(() => side.inPanel(`!document.getElementById('perm').hidden && !document.getElementById('perm').disabled`)).toBe(true);
  await side.click('#perm');
  await expect.poll(() => side.inPanel(`!document.getElementById('perm-menu').hidden`)).toBe(true);
  same('menu fill', await css('#perm-menu', 'backgroundColor'), CARD);
  same('menu border', await css('#perm-menu', 'borderTopColor'), LINE_STRONG);
  has('menu shadow is the app’s menu shadow', await css('#perm-menu', 'boxShadow'), /0px 8px 24px/);
  has('menu shadow has its 2px 6px layer', await css('#perm-menu', 'boxShadow'), /0px 2px 6px/);
  same('menu item text', await css('#perm-menu button', 'color'), TEXT);
  await side.screenshot(info.outputPath('menu-dark.png'));
  const askIndex = await side.inPanel(
    `[...document.querySelectorAll('#perm-menu button')].findIndex((b) => b.textContent.startsWith('Ask for approval')) + 1`,
  );
  expect(askIndex, 'the permission menu offers asking for approval').toBeGreaterThan(0);
  await side.click(`#perm-menu button:nth-of-type(${askIndex})`);

  // 4. a multi-step turn that waits for the user's OK: the approval card, then the finished steps
  const tool = (name: string) => `mcp__mopilot_chrome__${name}`;
  await send(
    `CUSTEPS\nCUCALL ${tool('navigate')} ${JSON.stringify({ tabId, url: otherSite })}\nCUCALL ${tool('read_page')} ${JSON.stringify({ tabId, filter: 'all' })}\nCUCALL ${tool('computer')} ${JSON.stringify({ tabId, action: 'screenshot' })}`,
  );
  await expect
    .poll(() => side.inPanel(`document.getElementById('cards').textContent`), { timeout: 60_000 })
    .toContain('Allow in this chat');
  await front.bringToFront();
  same('card border', await css('#cards .card', 'borderTopColor'), LINE);
  same('card title', await css('#cards .card .q', 'color'), TEXT);
  same('the progress line while waiting is muted', await css('#progress-text', 'color'), MUTED);
  // (the primary button's own key hint takes the button's text colour, so a chip on a plain button is the one that is muted)
  const key = await side.inPanel(`!!document.querySelector('#cards .card button:not(.primary) kbd')`);
  expect(key, 'a plain choice has its key chip').toBe(true);
  same('key chip is muted', await css('#cards .card button:not(.primary) kbd', 'color'), MUTED);
  same('a plain choice button has the .30 border', await css('#cards .choices button:not(.primary)', 'borderTopColor'), LINE_STRONG);
  const primary = await side.inPanel(`!!document.querySelector('#cards button.primary')`);
  expect(primary, 'the card has a primary choice').toBe(true);
  same('primary button fill', await css('#cards button.primary', 'backgroundColor'), 'rgb(236, 236, 236)');
  same('primary button text', await css('#cards button.primary', 'color'), 'rgb(32, 33, 36)');
  await side.screenshot(info.outputPath('card-dark.png'));
  await side.click('#cards button[data-choice="chat"]');
  await done();
  await expect
    .poll(() => side.inPanel(`document.querySelectorAll('#rows details.steps > summary').length`), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await front.bringToFront();
  await side.inPanel(`document.querySelectorAll('#rows details.steps').forEach((d) => { d.open = true; })`);
  same('the steps’ fold label is muted', await last('#rows details.steps > summary', 'color'), MUTED);
  same('a step row is muted', await last('#rows details.steps > .step', 'color'), MUTED);
  same('a step’s dot is muted', await last('#rows details.steps > .step', 'backgroundColor', '::before'), MUTED);
  same('the end-of-turn check is muted', await css('.progress .dot.ok', 'backgroundColor'), MUTED);
  // a failed step needs a failing tool; the stylesheet's rule for one is read on a stand-in row (synthetic, said so)
  same(
    'a failed step’s dot is the danger text colour (synthetic row)',
    await side.inPanel(`(() => {
      const row = document.createElement('div'); row.className = 'step'; row.dataset.state = 'failed'; row.textContent = 'Couldn’t click';
      document.getElementById('rows').append(row);
      const colour = getComputedStyle(row, '::before').backgroundColor;
      row.remove();
      return colour;
    })()`),
    'rgb(240, 106, 98)',
  );
  await side.screenshot(info.outputPath('steps-dark.png'));

  // 5. the sidebar
  await side.click('#side');
  await expect.poll(() => side.inPanel(`!document.getElementById('sidebar').hidden`)).toBe(true);
  await front.bringToFront();
  same('sidebar fill', await css('#sidebar', 'backgroundColor'), PAGE);
  same('sidebar search border', await css('#search', 'borderTopColor'), LINE);
  same('sidebar search text', await css('#search', 'color'), TEXT);
  same('sidebar search placeholder', await css('#search', 'color', '::placeholder'), MUTED);
  same('sidebar group heading is muted', await css('.sidebar h3', 'color'), MUTED);
  await side.screenshot(info.outputPath('sidebar-dark.png'));
  await side.click('#side-close');
  await expect.poll(() => side.inPanel(`document.getElementById('sidebar').hidden`)).toBe(true);

  // 6. a failed send: the error banner with Retry and a dismiss X, and the usage banner behind it
  await side.inPanel(`(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, ...rest) => {
      if (m?.type === 'panel' && m.method === 'send' && globalThis.__faults > 0) {
        globalThis.__faults--;
        return Promise.resolve({ status: 'connected', error: "MoPilot isn't connected.", code: 'panel_connection' });
      }
      return real(m, ...rest);
    };
    globalThis.__faults = 1;
  })()`);
  await send(FOLLOW_UP);
  await expect.poll(() => side.inPanel(`document.getElementById('error').hidden`), { timeout: 30_000 }).toBe(false);
  await expect.poll(() => side.inPanel(`document.getElementById('error').getAnimations().length === 0`)).toBe(true);
  await front.bringToFront();
  same('error banner fill is the red over the page', await css('#error', 'backgroundColor'), 'rgb(54, 31, 30)');
  same('error banner text is the red text', await css('#error', 'color'), 'rgb(240, 106, 98)');
  same('Retry follows the banner text', await css('#error .banner-retry', 'color'), 'rgb(240, 106, 98)');
  await side.screenshot(info.outputPath('error-banner-dark.png'));
  await side.inPanel(`(() => {
    const chat = document.getElementById('chat');
    chat.dataset.limitKey = 'b8'; chat.dataset.limitText = 'Usage limit reached on this account.';
  })()`);
  await expect.poll(() => side.inPanel(`document.getElementById('usage').hidden`)).toBe(false);
  // the usage banner shows once the error is gone: dismiss the error, then read it
  await side.click('#error .banner-dismiss');
  await expect.poll(() => side.inPanel(`document.getElementById('error').hidden`)).toBe(true);
  await side.inPanel(
    `(() => { const chat = document.getElementById('chat'); chat.dataset.limitKey = 'b8-again'; chat.dataset.limitText = 'Usage limit reached on this account.'; })()`,
  );
  await expect.poll(() => side.inPanel(`getComputedStyle(document.getElementById('usage')).display`)).not.toBe('none');
  await expect.poll(() => side.inPanel(`getComputedStyle(document.getElementById('usage')).opacity`)).toBe('1');
  await front.bringToFront();
  same('usage banner fill is the raised surface', await css('#usage', 'backgroundColor'), CARD);
  same('usage banner text', await css('#usage', 'color'), TEXT);
  await side.screenshot(info.outputPath('usage-banner-dark.png'));

  // 7. the same views in light: the app's light palette, and the screenshots to compare
  await scheme('light');
  same('light scheme is on', await side.inPanel(`matchMedia('(prefers-color-scheme: light)').matches`), true);
  same('light page', await css('body', 'backgroundColor'), 'rgb(251, 252, 254)');
  same('light text', await css('body', 'color'), 'rgb(24, 30, 42)');
  same('light toolbar hairline', await css('.bar', 'borderBottomColor'), 'rgb(228, 228, 228)');
  same('light composer card', await css('.composer-card', 'backgroundColor'), 'rgb(255, 255, 255)');
  has('light composer shadow', await css('.composer-card', 'boxShadow'), 'rgba(0, 0, 0, 0.08)');
  same('light user bubble', await last('#rows .you', 'backgroundColor'), 'rgb(240, 241, 243)');
  same('light link keeps the text colour', await last('#rows .reply a', 'color'), 'rgb(24, 30, 42)');
  same('light inline code text', await last('#rows .reply p code', 'color'), 'rgb(24, 30, 42)');
  same('light inline code fill', await last('#rows .reply p code', 'backgroundColor'), 'rgb(240, 241, 243)');
  same('light code block fill', await last('#rows .reply pre', 'backgroundColor'), 'rgb(240, 241, 243)');
  same('light table header fill', await last('#rows .reply th', 'backgroundColor'), 'rgb(240, 241, 243)');
  same('light usage banner fill', await css('#usage', 'backgroundColor'), 'rgb(240, 241, 243)');
  await side.screenshot(info.outputPath('usage-banner-light.png'));
  await side.inPanel(`document.getElementById('usage').setAttribute('data-yielded', '')`);
  await side.inPanel(
    `(() => { const e = document.getElementById('error'); e.hidden = false; e.replaceChildren(Object.assign(document.createElement('p'), { textContent: "MoPilot isn't connected." })); })()`,
  );
  await expect.poll(() => side.inPanel(`getComputedStyle(document.getElementById('error')).opacity`)).toBe('1');
  same('light error banner fill', await css('#error', 'backgroundColor'), 'rgb(249, 237, 235)');
  same('light error banner text', await css('#error', 'color'), 'rgb(201, 51, 42)');
  await side.screenshot(info.outputPath('error-banner-light.png'));
  await side.inPanel(
    `(() => { const e = document.getElementById('error'); e.hidden = true; e.replaceChildren(); document.getElementById('usage').removeAttribute('data-yielded'); })()`,
  );
  await side.inPanel(`__last('#rows .reply').scrollIntoView({ block: 'start' })`);
  await side.screenshot(info.outputPath('markdown-light.png'));
});
