// Reads back the URLs a launched app asked shell.openExternal to open; every launch records them instead of opening a
// browser or System Settings (fixtures/no-external.cjs).
import type { Harness } from './app';

/** The URLs the app has asked to open so far. */
export function openedExternal(h: Pick<Harness, 'app'>) {
  return h.app.evaluate(() => [...((globalThis as any).__opened ?? [])] as string[]);
}

/** Forget the URLs opened so far, and read back the ones opened from now on. */
export async function captureExternal(h: Pick<Harness, 'app'>) {
  await h.app.evaluate(() => void ((globalThis as any).__opened = []));
  return () => openedExternal(h);
}

/** Make the app's opener reject with `message` from now on (null: open again), as Electron does for a URL the system will not open. */
export function refuseExternal(h: Pick<Harness, 'app'>, message: string | null) {
  return h.app.evaluate((_electron, m) => void ((globalThis as any).__openRefusal = m), message);
}
