// Google Chrome on a scratch profile with MoPilot's real extension loaded unpacked (scripts/chrome-compare/extension.mjs), driven through Playwright over CDP: its pages, its side panel, and the native host the app writes into that profile.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startExtensionChrome } from '../../../scripts/chrome-compare/extension.mjs';
import { CHROME_BIN, devToolsPort } from './chromeProfile';
import { clickNativePanel } from './nativePanelClick.mjs';
import { waitFor } from '../../support/waitFor.ts';

const ROOT = path.resolve(__dirname, '../../..');
export const EXTENSION_DIR = path.join(ROOT, 'electron', 'chrome-extension');
/** The actual native side-panel target, including trusted input for privileged approval controls. */
export interface NativePanel {
  real: boolean;
  inPanel(expression: string): Promise<any>;
  click(selector: string, holdMs?: number, settled?: () => Promise<void>): Promise<void>;
  /** One trusted key press in the panel (Enter, Escape), with `meta` for Cmd held. */
  press(key: 'Enter' | 'Escape', meta?: boolean): Promise<void>;
  screenshot(file: string): Promise<void>;
  /** Sets the panel's emulated media features (for example prefers-reduced-motion), whatever the machine's own setting is. */
  emulateMedia(features: { name: string; value: string }[]): Promise<void>;
  panel(): Promise<Page>;
}
export interface ExtensionChrome {
  id: string;
  browser: Browser;
  context: BrowserContext;
  /** How many pairing pages (options.html#pair=) were answered: none when the in-app Allow paired it. */
  pairings(): Promise<number>;
  /** One of the extension's pages, opened in a new tab. */
  open(page: string): Promise<Page>;
  /** Loads another unpacked extension beside MoPilot's (one that injects its own frame into pages, as a password manager does). */
  loadExtension(dir: string): Promise<string>;
  /**
   * Opens Chrome's own side panel in `front`'s window, as the toolbar button does (a user gesture through `from`, one of
   * the extension's pages). Playwright doesn't list a side panel among a context's pages, so `inPanel` evaluates in
   * that panel's frame over the DevTools pipe, and `panel()` gives the page a journey drives: the side panel itself when
   * Playwright lists it (real: true), else sidepanel.html opened in a tab of the same window (the same page and
   * background, not inside the side panel's frame; that tab is then the window's active one).
   */
  sidePanel(from: Page, front: Page): Promise<NativePanel>;
  close(): Promise<void>;
}

/** Starts Chrome on `userDataDir` with the extension loaded unpacked, and connects Playwright to it. */
export async function startChrome(userDataDir: string, log: (s: string) => void = () => {}): Promise<ExtensionChrome> {
  // the pipe loads the extension (Google Chrome takes no --load-extension); the port is Playwright's
  const withPort: typeof spawn = ((bin: string, args: string[], o: any) =>
    spawn(bin, [...args, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-search-engine-choice-screen'], o)) as any;
  const ext = await startExtensionChrome({ spawn: withPort, bin: CHROME_BIN, userDataDir, extensionDir: EXTENSION_DIR, log });
  const file = path.join(userDataDir, 'DevToolsActivePort');
  let port = null as number | null;
  await waitFor(
    () => {
      port = devToolsPort(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
      return port !== null;
    },
    'DevToolsActivePort',
    { timeoutMs: 10_000 },
  ).catch(() => undefined);
  if (port === null) {
    await ext.close();
    throw new Error('Chrome did not write DevToolsActivePort');
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const id: string = ext.id;
  const panelUrl = `chrome-extension://${id}/sidepanel.html`;
  const open = async (page: string) => {
    const p = await context.newPage();
    await p.goto(`chrome-extension://${id}/${page}`);
    return p;
  };
  return {
    id,
    browser,
    context,
    pairings: () => ext.pairings(),
    open,
    loadExtension: async (dir) => ((await ext.cdp.send('Extensions.loadUnpacked', { path: dir })) as { id: string }).id,
    sidePanel: async (from, front) => {
      await front.bringToFront();
      // the window `front` is in (a page Playwright opens may get a window of its own)
      const { windowId, tabId } = await from.evaluate(async (url) => {
        const tabs = await (globalThis as any).chrome.tabs.query({});
        const t = tabs.find((t: any) => t.url === url);
        return { windowId: t?.windowId, tabId: t?.id };
      }, front.url());
      if (typeof windowId !== 'number' || typeof tabId !== 'number') throw new Error(`no Chrome tab on ${front.url()}`);
      const tabPanelUrl = `${panelUrl}?tabId=${tabId}`;
      const cdp = await context.newCDPSession(from);
      // that tab's own panel, as the toolbar button opens it (panelTab.mjs openPanel)
      const opened = await cdp.send('Runtime.evaluate', {
        expression: `(chrome.sidePanel.setOptions({ tabId: ${Number(tabId)}, path: 'sidepanel.html?tabId=${Number(tabId)}', enabled: true }),
          chrome.sidePanel.open({ tabId: ${Number(tabId)} })).then(() => 'opened', (e) => String(e))`,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      });
      log(`side panel: ${JSON.stringify(opened.result?.value)}`);
      let target = null as any;
      await waitFor(
        async () => {
          const { targetInfos } = await ext.cdp.send('Target.getTargets');
          // the panel of that tab (each tab has its own: sidepanel.html?tabId=N)
          target = targetInfos.find((t: any) => t.type === 'page' && String(t.url) === tabPanelUrl);
          return target;
        },
        'the side panel target',
        { timeoutMs: 10_000 },
      ).catch(() => undefined);
      if (!target) throw new Error(`Chrome's side panel did not open: ${JSON.stringify(opened.result)}`);
      const { sessionId } = await ext.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const inPanel = async (expression: string) => {
        const r = await ext.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(`in the side panel: ${JSON.stringify(r.exceptionDetails)}`);
        return r.result?.value;
      };
      const click = (selector: string, holdMs = 0, settled?: () => Promise<void>) =>
        clickNativePanel(
          { inPanel, send: (event) => ext.cdp.send('Input.dispatchMouseEvent', event, sessionId) },
          selector,
          holdMs,
          settled,
        );
      const press = async (key: 'Enter' | 'Escape', meta = false) => {
        const base = { key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27, modifiers: meta ? 4 : 0 };
        await ext.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) }, sessionId);
        await ext.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
      };
      const screenshot = async (file: string) => {
        const { data } = await ext.cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
      };
      const emulateMedia = async (features: { name: string; value: string }[]) => {
        await ext.cdp.send('Emulation.setEmulatedMedia', { features }, sessionId);
      };
      const listed = context.pages().find((p) => p.url() === tabPanelUrl);
      if (listed) return { real: true, inPanel, click, press, screenshot, emulateMedia, panel: async () => listed };
      const panel = async () => {
        // in the same window, so its tabs (and @'s list) are the ones the side panel sees
        await from.evaluate(({ windowId, url }) => (globalThis as any).chrome.tabs.create({ windowId, url }), {
          windowId,
          url: tabPanelUrl,
        });
        let tab = undefined as Page | undefined;
        await waitFor(() => (tab = context.pages().find((p) => p.url() === tabPanelUrl)), 'the side panel tab', {
          timeoutMs: 10_000,
        }).catch(() => undefined);
        if (!tab) throw new Error('sidepanel.html did not open in a tab');
        await tab.waitForLoadState();
        return tab;
      };
      return { real: false, inPanel, click, press, screenshot, emulateMedia, panel };
    },
    close: async () => {
      await browser.close().catch(() => {});
      await ext.close();
    },
  };
}
