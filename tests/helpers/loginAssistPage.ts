// In-memory webContents fixture for saved-login dropdown and submission tests.
import { EventEmitter } from 'node:events';

/** A page's webContents: `scripts` collects what main runs in the fill world; `answer` decides what it returns. */
export function fakePage(url = 'https://a.test/login', id = 7) {
  const wc: any = new EventEmitter();
  wc.id = id;
  wc.url = url;
  wc.destroyed = false;
  wc.scripts = [] as { world: number; code: string }[];
  wc.typed = [] as string[];
  wc.answer = (_code: string): any => undefined;
  wc.getURL = () => wc.url;
  wc.isDestroyed = () => wc.destroyed;
  wc.isLoadingMainFrame = () => false;
  wc.executeJavaScriptInIsolatedWorld = async (world: number, [{ code }]: { code: string }[]) => {
    wc.scripts.push({ world, code });
    return wc.answer(code);
  };
  wc.insertText = async (t: string) => void wc.typed.push(t);
  return wc;
}
