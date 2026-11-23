// A Host browser service on a fake Chromium, for the service's tests (host/src/browserHost.mjs).
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createBrowserHost, BrowserHostError } from '../../host/src/browserHost.mjs';
import { FakeChromium, timers } from './fake-chromium.ts';

export const DOWNLOADS = path.join('/host', 'downloads');

export function world(o: any = {}) {
  const chromium = new FakeChromium();
  const clock = timers();
  const files = {
    saved: new Set<string>(),
    renames: [] as string[][],
    existsSync: (f: string) => files.saved.has(f),
    renameSync: (a: string, b: string) => void files.renames.push([a, b]),
  };
  const host = createBrowserHost({
    launch: chromium.launch,
    downloadsDir: DOWNLOADS,
    idleMs: 1000,
    graceMs: 2000,
    commandMs: 3000,
    files,
    ...clock,
    ...o,
  });
  const events: Record<string, any[]> = {};
  const hear = (chat: string) => {
    events[chat] = [];
    return host.subscribe(chat, (e: any) => events[chat].push(e));
  };
  return { chromium, clock, files, host, events, hear };
}
export const code = (c: string) => (e: any) => e instanceof BrowserHostError && e.code === c;
/** A chat with an attached tab. */
export async function tab(w: ReturnType<typeof world>, chat = 'c') {
  const { targetId } = await w.host.open(chat);
  await w.host.attach(chat, targetId);
  return targetId as string;
}
