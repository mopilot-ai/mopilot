// Legacy guest navigation enters main before changing the page, so older agent loads cannot overwrite it.
import { native } from '../../../lib/native';
import type { WebviewElement } from '../../../session/useBrowserShortcuts';

const handles = new WeakMap<WebviewElement, WebviewElement>();
const actions = new Set(['loadURL', 'goBack', 'goForward', 'reload', 'reloadIgnoringCache']);
const navigates = (key: string | symbol): key is Parameters<typeof native.browser.navigateGuest>[1] =>
  typeof key === 'string' && actions.has(key);

export function guestNavigation(page: WebviewElement, failed: () => void): WebviewElement {
  let handle = handles.get(page);
  if (!handle) {
    handle = new Proxy(page, {
      get(target, key) {
        if (navigates(key))
          return (url?: string) => {
            const pending = native.browser.navigateGuest(target.getWebContentsId(), key, url);
            if (key === 'loadURL') return pending;
            void pending.catch(failed);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    handles.set(page, handle);
  }
  return handle;
}
