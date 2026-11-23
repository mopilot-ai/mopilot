// Browser-pane shortcut delivery and reload recovery, scoped to the visible live page.
import { useEffect, useRef, type RefObject } from 'react';
import { useEffectOn } from '../lib/effects';
import { native } from '../lib/native';
import { noteIgnored } from '../lib/ignored';
import { copyText } from './clipboard';

/** The parts of Electron's <webview> element (WebviewTag) this panel uses; a view's ViewHandle has them too. */
export interface WebviewElement {
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
  getZoomFactor(): number;
  /** main-owned views only: whether the zoom fits the pane, and the user's zoom for the page's site */
  isZoomAuto?(): boolean;
  zoom?(action: 'in' | 'out' | 'reset'): void;
  getWebContentsId(): number;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  loadURL(url: string): Promise<void>;
  reload(): void;
  reloadIgnoringCache(): void | Promise<void>;
  goBack(): void;
  goForward(): void;
  stop(): void;
  /** a <webview>'s own, or main's for a view (a remote tab's page has none): the request id, as the found-in-page events carry it */
  findInPage?(text: string, options: { forward: boolean; findNext: boolean }): number | Promise<number>;
  stopFindInPage?(action: 'clearSelection'): void;
}

export function reloadBrowserPage(options: {
  failedUrl: RefObject<string | null>;
  clearError(): void;
  crashed: boolean;
  /** the page is a form result Back or a reload couldn't show: only the notice's Resubmit sends the form again */
  formResult?: boolean;
  restart(): void;
  page: WebviewElement | null;
  loadError(error: Error, message: string): void;
  unavailable(): void;
}) {
  // loading its address would be a GET the form never sent (a 405 or an empty page), and a reload posts nothing
  if (options.formResult) return;
  const retryUrl = options.failedUrl.current;
  options.failedUrl.current = null;
  options.clearError();
  if (options.crashed) return options.restart();
  try {
    if (retryUrl)
      options.page?.loadURL(retryUrl).catch((e) => options.loadError(e, "Couldn't reload this page. Try again or continue in Chrome."));
    else options.page?.reload();
  } catch {
    options.unavailable();
  }
}

export function useBrowserShortcuts(options: {
  page: RefObject<WebviewElement | null>;
  address: RefObject<HTMLInputElement | null>;
  front: boolean;
  paneId: string;
  url: string;
  reload(): void;
  annotate(): void;
  /** the page's find bar: open (or focus) it, or step to the next or previous match */
  find(action: 'open' | 'next' | 'previous'): void;
  unavailable(): void;
}) {
  const lifetime = useRef<object | null>(null);
  const modifierRoot = useRef<number | null>(null);
  const modifiers = (combo: string) =>
    window.dispatchEvent(new CustomEvent('browser-shortcut-modifiers', { detail: { combo, paneId: options.paneId } }));
  useEffectOn([options.front, options.paneId, options.page], () => {
    lifetime.current = {};
    return () => {
      if (modifierRoot.current !== null) {
        modifierRoot.current = null;
        modifiers('');
      }
      lifetime.current = null;
    };
  });
  useEffect(() => {
    const owner = lifetime.current;
    const workspace = (event: Event) => {
      const d = (event as CustomEvent<{ id: string; paneId: string }>).detail;
      if (!options.front || d.paneId !== options.paneId) return;
      const page = options.page.current;
      try {
        switch (d.id) {
          case 'browser-address':
            options.address.current?.focus();
            options.address.current?.select();
            break;
          case 'browser-back':
            if (page?.canGoBack()) page.goBack();
            break;
          case 'browser-forward':
            if (page?.canGoForward()) page.goForward();
            break;
          case 'browser-reload':
            options.reload();
            break;
          case 'browser-reload-cache':
            page?.reloadIgnoringCache()?.catch(() => {
              if (lifetime.current === owner && options.page.current === page) options.unavailable();
            });
            break;
          case 'browser-copy-url':
            copyText(page?.getURL() || options.url, 'Copied URL');
            break;
          case 'browser-annotate':
            if (page) options.annotate();
            break;
          case 'browser-find':
          case 'browser-find-next':
          case 'browser-find-previous':
            options.find(d.id === 'browser-find' ? 'open' : d.id === 'browser-find-next' ? 'next' : 'previous');
            break;
          case 'browser-zoom-in':
          case 'browser-zoom-out':
          case 'browser-zoom-reset':
            page?.zoom?.(d.id === 'browser-zoom-reset' ? 'reset' : d.id === 'browser-zoom-in' ? 'in' : 'out');
            break;
        }
      } catch {
        options.unavailable();
      }
    };
    const off = native.browser.onShortcut(({ rootId, combo, modifiers: isModifiers }) => {
      if (isModifiers && !combo && modifierRoot.current === rootId) {
        modifierRoot.current = null;
        modifiers('');
        return;
      }
      const page = options.page.current;
      // A closed guest can throw while unbinding; it no longer owns any command.
      try {
        if (options.front && page && rootId === page.getWebContentsId()) {
          if (isModifiers) {
            modifierRoot.current = rootId;
            modifiers(combo);
          } else window.dispatchEvent(new CustomEvent('browser-shortcut', { detail: { combo, paneId: options.paneId } }));
        }
      } catch {
        // Optional hint metadata can arrive before a page is bound; no browser action failed.
        if (!isModifiers) options.unavailable();
      }
    });
    window.addEventListener('workspace-shortcut', workspace);
    return () => {
      off();
      window.removeEventListener('workspace-shortcut', workspace);
    };
  });
}

/** A page without an attached guest has no usable native id yet. */
export function browserPageId(rootId: number | null, page: WebviewElement | null): number | null {
  try {
    return rootId ?? page?.getWebContentsId() ?? null;
  } catch (error) {
    noteIgnored("read a browser pane page's id", error);
    return null;
  }
}
