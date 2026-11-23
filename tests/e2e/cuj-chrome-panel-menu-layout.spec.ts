// The real Chrome side panel keeps model choices above a growing composer, compact and scrollable at narrow widths.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

test.skip(process.platform !== 'darwin', 'the real Chrome extension pairs with the macOS app');
test.use({ harnesses: 'codex' });
test.describe.configure({ timeout: 240_000 });

test('model menus fit above an expanded draft and preserve reachable choices in the native Chrome panel', async ({
  page,
  launchChrome,
}, info) => {
  const server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Menu layout</title><h1>Menu layout</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const chrome = await launchChrome();
    const welcome = await pairWithAllow(page, chrome);
    const front = await chrome.context.newPage();
    await front.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const cdp = await chrome.context.newCDPSession(front);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1024, height: 760 } });
    const side = await chrome.sidePanel(welcome, front);
    await completePanelFirstRun(side);
    await expect.poll(() => side.inPanel(`document.getElementById('model').textContent`)).not.toBe('Choose model');
    await side.emulateMedia([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await side.click('#model');
    await expect.poll(() => side.inPanel(`!!document.querySelector('#model-rows .effort-title')`)).toBe(true);
    expect(await side.inPanel(`document.querySelectorAll('#model-rows h4').length`)).toBe(1);
    // Native ACP effort names are unbounded; the shared first-view header must still keep its model visible.
    const longHeader = await side.inPanel(`(() => {
      const title = document.querySelector('.effort-title');
      const name = title.querySelector('.effort-name');
      name.textContent = 'Maximum reasoning for difficult multi-step tasks';
      const model = title.querySelector('.effort-model').getBoundingClientRect();
      return { effort: name.textContent, fits: title.scrollWidth <= title.clientWidth && model.width > 0 };
    })()`);
    expect(longHeader).toEqual({ effort: 'Maximum reasoning for difficult multi-step tasks', fits: true });
    await info.attach('long-effort-header', { body: JSON.stringify(longHeader), contentType: 'application/json' });
    await side.screenshot(info.outputPath('compact-effort.png'));
    await side.click('#model-rows .effort-title');
    await side.inPanel(String.raw`(() => {
      const more = document.querySelector('#model-rows .more');
      if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
      const text = document.getElementById('text');
      text.value = Array.from({length: 20}, (_, i) => 'Keep draft line ' + i).join('\n');
      text.dispatchEvent(new Event('input'));
      const error = document.getElementById('error');
      error.hidden = false;
      error.textContent = 'A long recoverable notice. '.repeat(60);
    })()`);

    // Observer delivery is asynchronous: wait for the current height budget before measuring it.
    const fits = `(() => {
      const menu = document.getElementById('model-menu');
      const r = menu.getBoundingClientRect();
      const c = document.getElementById('composer').getBoundingClientRect();
      return r.width > 0 && r.width <= 300 && r.left >= c.left && r.right <= c.right
        && r.top >= 5 && r.bottom <= c.top - 5 && r.height <= 360
        && menu.scrollHeight > menu.clientHeight
        && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
    })()`;
    await expect.poll(() => side.inPanel(fits)).toBe(true);
    await side.screenshot(info.outputPath('expanded-draft-models.png'));
    const tallHeight = await side.inPanel('innerHeight');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { height: 682 } });
    await expect.poll(() => side.inPanel('innerHeight')).toBeLessThan(tallHeight);
    await expect.poll(() => side.inPanel(fits)).toBe(true);

    // A narrow host and larger menu text exercise both axes, rather than a text-only menu assertion.
    await side.inPanel(`document.body.style.width = 'min(320px, 100%)'; document.body.style.fontSize = '24px'`);
    await expect.poll(() => side.inPanel(fits)).toBe(true);
    await side.inPanel(`document.getElementById('model-menu').scrollTop = document.getElementById('model-menu').scrollHeight`);
    const last = await side.inPanel(`(() => {
      const menu = document.getElementById('model-menu');
      const button = [...menu.querySelectorAll('[role=menuitemradio]')].at(-1);
      const r = button.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      return { label: button.textContent, visible: r.top >= m.top && r.bottom <= m.bottom };
    })()`);
    expect(last.visible).toBe(true);
    await side.screenshot(info.outputPath('narrow-large-text-models.png'));
    await side.click('#model-rows > button:last-child');
    await expect.poll(() => side.inPanel(`document.getElementById('model-menu').hidden`)).toBe(true);
    await expect
      .poll(() => side.inPanel(`document.getElementById('model').textContent.startsWith(${JSON.stringify(last.label)})`))
      .toBe(true);
    expect(await side.inPanel(String.raw`document.getElementById('text').value.startsWith('Keep draft line 0\n')`)).toBe(true);

    // Give the document enough scroll range to put the form at the near-edge padding/border boundary.
    await side.inPanel(`(() => {
      const spacer = document.createElement('div');
      spacer.style.flex = '0 0 300px';
      document.body.append(spacer);
    })()`);
    // The permission and add popups share the same live height budget, including scrolling without a resize.
    for (const [trigger, id] of [
      ['#perm', 'perm-menu'],
      ['#plus', 'plus-menu'],
    ]) {
      await side.click(trigger);
      await side.inPanel(`window.scrollBy(0, document.getElementById('composer').getBoundingClientRect().top - 20)`);
      const geometry = () =>
        side.inPanel(`(() => {
        const menu = document.getElementById('${id}');
        const r = menu.getBoundingClientRect();
        const composer = document.getElementById('composer');
        const c = composer.getBoundingClientRect();
        const toolbar = document.getElementById('plus').getBoundingClientRect();
        return {
          visible: !menu.hidden,
          fits: r.width > 0 && r.width <= 300 && r.top >= 5 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          nearTop: Math.abs(c.top - 20) < 1,
          rect: r.toJSON(), composer: c.toJSON(), toolbar: toolbar.toJSON(),
          scrollTop: document.scrollingElement.scrollTop,
          budget: composer.style.getPropertyValue('--menu-space'),
          shift: composer.style.getPropertyValue('--menu-shift')
        };
      })()`);
      try {
        await expect.poll(geometry).toMatchObject({ visible: true, fits: true, nearTop: true });
      } finally {
        await info.attach(`${id}-geometry`, { body: JSON.stringify(await geometry()), contentType: 'application/json' });
        await side.screenshot(info.outputPath(`${id}.png`));
      }
      await side.press('Escape');
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
