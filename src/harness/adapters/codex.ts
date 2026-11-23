// The Codex adapter as a window sees it: an IPC proxy to the adapter in main
// (electron/harness/codex.cjs), which owns the one app-server connection. Requests go out from main
// and the result comes back to the window that asked; notifications arrive under their chat.
import { native } from '../../lib/native';

let idle: () => boolean = () => false;
/** The store says whether Codex was left for first use: background reads then don't wake it. */
export const codexIsIdle = (fn: () => boolean) => void (idle = fn);
/** Codex was left for first use (nothing has started it yet). */
export const codexLeftIdle = () => idle();

/** One app-server request; rejects with the app-server's own error message. */
export function codexRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (idle()) return Promise.reject(new Error("Codex isn't started"));
  return native.codex.request<T>(method, params ?? {});
}

/**
 * Answer an approval or question card: false when main no longer holds it for the running app-server, so nothing
 * was sent. Rejects when the answer did not reach main (resolveRequest says so).
 */
export function respondToCodex(id: number | string, result: unknown): Promise<boolean> {
  return native.codex.respond(id, result);
}

/** App-server notifications, under their chat's id (main maps a later segment's thread to its chat). */
export function onCodexNotification(h: (method: string, params: unknown) => void): () => void {
  return native.codex.onItem((e) => {
    if (e.kind === 'notification') h(e.method, e.params);
  });
}
