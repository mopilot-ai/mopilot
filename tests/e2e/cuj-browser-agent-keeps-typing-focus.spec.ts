// CUJ (#4640): an agent driving the built-in browser in chat A never takes keyboard focus from the person typing in chat B's
// composer. While A's fake turn loops navigate / click / type / screenshot / new tab, the test types into B's composer
// (plain keys and a simulated input-method composition) and asserts that every character lands in order, the composer stays
// the active element and never blurs, no composition is cancelled, and neither the window nor the page took focus or
// activation (a webContents or window focus event in main, a window blur in the renderer).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { standaloneNewChat } from './fixtures/sidebar';
import { sizeViewport } from './fixtures/window';

test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');
// real focus behaviour: the default background mode makes focus() and show() no-ops (electron/app/backgroundMode.cjs)
test.use({ harnesses: 'codex', env: { SAGE_E2E_BACKGROUND: '0' } });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const PANE = { hidden: 'behind chat B', window: 'open in a second window', split: 'in a split beside chat B' };
const ROUNDS = 12;
const PAGE = `<!doctype html><title>Form</title><h1>Form</h1><input id="a" name="a" autofocus>
<button id="b" style="position:fixed;left:0;top:0;width:240px;height:120px" onclick="window.open('/?popup')">Go</button>`;

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const call = (tool: string, args: object) => `CUCALL browser_${tool} ${JSON.stringify(args)}`;

/** One browser journey of the agent: navigate, click, type, screenshot, a new tab. */
function journey(): string[] {
  const lines = [call('navigate', { url: `${site}/` })];
  for (let i = 0; i < ROUNDS; i += 1) {
    lines.push(
      call('computer', { action: 'left_click', coordinate: [60, 40] }),
      call('computer', { action: 'type', text: `agent ${i}` }),
      call('computer', { action: 'screenshot' }),
      call('tabs_create', { url: `${site}/?n=${i}` }),
      call('navigate', { url: `${site}/?m=${i}` }),
    );
  }
  return lines;
}

for (const where of ['hidden', 'window', 'split'] as const) {
  test(`an agent using the browser in chat A (pane ${PANE[where]}) never moves focus or cancels an input-method composition in chat B`, async ({
    page,
    harness,
  }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    // chat A: the long browser journey; its site card is answered before the person goes to chat B
    await composer(page).fill(journey().join('\n'));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const card = page.locator('.sage-approval');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await pickScope(card, /Allow in this chat/);
    await expect(page.locator('.composer').getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

    const chatA = await page.locator('.thread-view[data-thread-id]').getAttribute('data-thread-id');
    if (where === 'window') {
      // chat A's pane stays on screen in its own window while the person goes on in this one
      const second = harness.app.waitForEvent('window');
      await page.evaluate(
        (id) => (window as unknown as { native: { win: { open(h: string): Promise<void> } } }).native.win.open(`#thread=${id}`),
        chatA,
      );
      await (await second).waitForLoadState('domcontentloaded');
      await harness.app.evaluate(({ BrowserWindow }) => {
        const first = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#thread='));
        first?.focus();
      });
    }

    // chat B: the person's own composer
    await standaloneNewChat(page).click();
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    // chat B is a thread with a turn running (SLOW waits until interrupted), as when a person works in two chats
    await composer(page).fill('SLOW keep this turn running');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.composer').getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    const box = composer(page).first();
    await box.click();

    if (where === 'split') {
      // chat A beside chat B in the same window: its page is drawn next to the composer being typed in. A split opens only
      // with room for a second column (src/store/splitView.ts openInSplit), so the window is sized for two and the Summary
      // pane, which takes that room, is closed first (#4780: on the runner's small window the Alt-click left one composer)
      await sizeViewport(page, harness, 1280, 800);
      const summary = page.getByRole('button', { name: 'Summary', exact: true });
      if ((await summary.getAttribute('class'))?.split(' ').includes('active')) await summary.click();
      await expect.poll(async () => (await page.locator('.split-frame').boundingBox())?.width ?? 0).toBeGreaterThan(720);
      await page.locator(`[data-sidebar-chat="${chatA}"]`).click({ modifiers: ['Alt'] });
      await expect(composer(page)).toHaveCount(2);
      await box.click();
    }

    // the window the person types in, and proof that it is the key window before the agent's next action
    await page.evaluate(() => ((window as unknown as { __home: boolean }).__home = true));
    const home = await harness.app.evaluate(async ({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed() || !w.webContents.getURL().startsWith('file:')) continue;
        try {
          if (await w.webContents.executeJavaScript('window.__home === true')) {
            w.focus();
            return w.id;
          }
        } catch {
          // a window that is not an app window
        }
      }
      return -1;
    });
    expect(home).toBeGreaterThan(0);
    await expect.poll(() => harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? -1)).toBe(home);

    // main: count every focus or activation of any window or page from here on; renderer: every blur and composition event
    await harness.app.evaluate(({ app, webContents, BrowserWindow }, homeId) => {
      const g = globalThis as unknown as { __focus: string[] };
      g.__focus = [];
      const d = globalThis as unknown as { __driven: number };
      d.__driven = 0;
      const count = (wc: Electron.WebContents) => wc.on('did-navigate', () => (d.__driven += 1));
      const note = (what: string) => g.__focus.push(what);
      const label = (wc: Electron.WebContents) => {
        const owner = BrowserWindow.fromWebContents(wc);
        const key = BrowserWindow.getFocusedWindow();
        return `${wc.id} ${wc.getType()} ${wc.getURL().slice(0, 40)} win=${owner?.id ?? 'none'} keyWindow=${key?.id ?? 'none'}`;
      };
      // the key window must stay the one the person types in
      let key = BrowserWindow.getFocusedWindow()?.id ?? -1;
      setInterval(() => {
        const now = BrowserWindow.getFocusedWindow()?.id ?? -1;
        if (now !== key) note(`key window ${key} -> ${now}`);
        key = now;
      }, 10);
      // calls that take focus: the OS may give no event on a runner, so the call itself is the evidence
      const spy = (proto: any, name: string, label: string) => {
        const original = proto[name];
        proto[name] = function (...args: unknown[]) {
          const where = (new Error().stack ?? '')
            .split('\n')
            .slice(2, 5)
            .map((l) => l.trim().replace(/\(.*[\\/]/, '('))
            .join(' < ');
          note(`call ${label}.${name} ${where}`);
          return original.apply(this, args);
        };
      };
      const win = BrowserWindow.getAllWindows()[0];
      for (const n of [
        'focus',
        'show',
        'showInactive',
        'moveTop',
        'restore',
        'setAlwaysOnTop',
        'setFocusable',
        'setVisibleOnAllWorkspaces',
      ])
        spy(Object.getPrototypeOf(win), n, 'BrowserWindow');
      spy(Object.getPrototypeOf(win.webContents), 'focus', 'webContents');
      spy(app, 'focus', 'app');
      spy(app, 'show', 'app');
      if (app.dock) spy(app.dock, 'show', 'dock');
      // a page blurring inside another window (the agent's own page, as it navigates and opens tabs in the pane's window)
      // takes nothing from the person: only a blur in the person's own window, or one while another window is key, counts;
      // a key-window change and every focus call are still noted above and below (#4806: wc-blur of the pane window's page
      // with keyWindow = the person's window, in 1 of 6 second-window runs)
      const blurred = (wc: Electron.WebContents) => {
        const own = BrowserWindow.fromWebContents(wc)?.id === homeId;
        if (own || BrowserWindow.getFocusedWindow()?.id !== homeId) note(`wc-blur ${label(wc)}`);
      };
      app.on('browser-window-created', (_e, w) => note(`created window ${w.getTitle() || '(untitled)'} focusable=${w.isFocusable()}`));
      // only what takes the key from the person counts: another window gaining focus, or the person's own window blurring. The
      // handoff from the second window that the spec itself made (`first.focus()`) is delivered late as `window-blur` of the
      // other window and `window-focus` of the person's own, with the key already theirs (#4806: 3 of 10 second-window runs)
      app.on('browser-window-focus', (_e, w) => {
        if (w.id !== homeId) note(`window-focus id=${w.id} key=${BrowserWindow.getFocusedWindow()?.id}`);
      });
      app.on('browser-window-blur', (_e, w) => {
        if (w.id === homeId) note(`window-blur id=${w.id} key=${BrowserWindow.getFocusedWindow()?.id}`);
      });
      for (const wc of webContents.getAllWebContents()) {
        count(wc);
        wc.on('focus', () => note(`wc-focus ${label(wc)}`));
        wc.on('blur', () => blurred(wc));
      }
      app.on('web-contents-created', (_e, wc) => {
        count(wc);
        wc.on('focus', () => note(`wc-focus ${label(wc)}`));
        wc.on('blur', () => blurred(wc));
      });
    }, home);
    await page.evaluate(() => {
      const log: string[] = [];
      (window as unknown as { __typing: string[] }).__typing = log;
      const el = document.activeElement as HTMLElement;
      for (const type of ['blur', 'focusout']) el.addEventListener(type, () => log.push(type));
      // every composition must end by committing what the input method produced, never by a cancel (empty data)
      el.addEventListener('compositionstart', () => log.push('compositionstart'));
      el.addEventListener('compositionend', (e) => log.push(`compositionend:${(e as CompositionEvent).data}`));
      window.addEventListener('blur', () => log.push('window-blur'));
      const rect0 = el.getBoundingClientRect();
      const thread0 = document.querySelector('.thread-view')?.getAttribute('data-thread-id');
      setInterval(() => {
        if (!document.hasFocus()) log.push('page-unfocused');
        if (document.activeElement !== el) log.push('active-element-changed');
        // a remount, or a different chat or layout under the person's hands
        if (!el.isConnected) log.push('composer-removed');
        const r = el.getBoundingClientRect();
        // the typed text wraps and the composer grows in height (and upward, where it sits at the bottom): only a sideways move
        // means another composer or layout, so the vertical position is not compared. Nor is the width: a split pane rebalances its
        // columns while the agent's page opens beside it (x and y unchanged, width 285 to 419, #4806 detail run 44049836631)
        if (Math.abs(r.x - rect0.x) > 1) log.push('composer-moved');
        if (document.querySelector('.thread-view')?.getAttribute('data-thread-id') !== thread0) log.push('chat-changed');
      }, 20);
      // the composer's own content changing other than by typing (a value reset, a remount) and slow input
      (window as unknown as { __mut: number }).__mut = 0;
      (window as unknown as { __maxDelay: number }).__maxDelay = 0;
      (window as unknown as { __longTasks: number[] }).__longTasks = [];
      new PerformanceObserver((list) => {
        const w = window as unknown as { __maxDelay: number };
        for (const e of list.getEntries())
          w.__maxDelay = Math.max(w.__maxDelay, (e as PerformanceEventTiming).processingStart - e.startTime);
      }).observe({ type: 'event', durationThreshold: 16, buffered: false });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) (window as unknown as { __longTasks: number[] }).__longTasks.push(Math.round(e.duration));
      }).observe({ type: 'longtask', buffered: false });
    });

    const cdp = await page.context().newCDPSession(page);
    let expected = '';
    for (let i = 0; i < ROUNDS * 2; i += 1) {
      await page.keyboard.type(`k${i} `, { delay: 15 });
      expected += `k${i} `;
      // a pinyin composition cancelled by a focus change leaves its candidate text behind or drops it
      await cdp.send('Input.imeSetComposition', {
        text: 'ni',
        selectionStart: 2,
        selectionEnd: 2,
      });
      await page.waitForTimeout(120);
      await cdp.send('Input.imeSetComposition', {
        text: 'nihao',
        selectionStart: 5,
        selectionEnd: 5,
      });
      await page.waitForTimeout(120);
      await cdp.send('Input.insertText', { text: '你好' });
      expected += '你好';
      await page.waitForTimeout(150);
      // after every round: the text is all there (no reset), and the caret sits at its end (no jump, no replaced selection)
      const state = await box.evaluate((el) => {
        const sel = getSelection();
        let caret = -1;
        if (sel && sel.rangeCount && el.contains(sel.anchorNode) && sel.isCollapsed) {
          const r = document.createRange();
          r.selectNodeContents(el);
          r.setEnd(sel.anchorNode as Node, sel.anchorOffset);
          caret = r.toString().length;
        }
        return { text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), caret, length: (el.textContent ?? '').length };
      });
      expect(state.text, `round ${i}`).toBe(expected.replace(/\s+/g, ' ').trim());
      expect(state.caret, `caret in round ${i}`).toBe(state.length);
    }

    const typing = await page.evaluate(() => (window as unknown as { __typing: string[] }).__typing);
    const focus = await harness.app.evaluate(() => (globalThis as unknown as { __focus: string[] }).__focus);
    // the agent drove pages while the person typed: else the run proves nothing
    const driven = await harness.app.evaluate(() => (globalThis as unknown as { __driven: number }).__driven);
    console.log(`pages navigated by the agent during the typing: ${driven}`);
    expect(driven).toBeGreaterThan(3);
    const text = (await box.innerText()).replace(/\s+/g, ' ').trim();
    console.log(`typing events: ${JSON.stringify([...new Set(typing)].slice(0, 8))}; main focus events: ${JSON.stringify(focus)}`);

    expect(text).toBe(expected.replace(/\s+/g, ' ').trim());
    const starts = typing.filter((t) => t === 'compositionstart').length;
    const ends = typing.filter((t) => t.startsWith('compositionend'));
    expect(starts).toBe(ROUNDS * 2);
    expect(ends).toEqual(Array(ROUNDS * 2).fill('compositionend:你好'));
    expect(typing.filter((t) => !t.startsWith('composition'))).toEqual([]);
    expect(focus).toEqual([]);
    const delay = await page.evaluate(() => ({
      maxDelay: (window as unknown as { __maxDelay: number }).__maxDelay,
      longTasks: (window as unknown as { __longTasks: number[] }).__longTasks,
    }));
    console.log(`input delay max ${Math.round(delay.maxDelay)}ms; long tasks ${JSON.stringify(delay.longTasks)}`);
    expect(delay.maxDelay).toBeLessThan(300);
  });
}
