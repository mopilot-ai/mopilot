// Remote tabs on a Host's browser service on a fake Chromium, for the tab tests (electron/capabilities/browser/remoteHost.cjs).
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createBrowserHost } from '../../host/src/browserHost.mjs';
import { FakeChromium, timers } from './fake-chromium.ts';
import { image } from './browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { remoteBrowserTabs } = require('../../electron/capabilities/browser/remoteHost.cjs');

const mocked = new WeakSet();
export function world(t: any, o: any = {}) {
  if (!mocked.has(t)) t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  mocked.add(t);
  const chromium: FakeChromium = o.chromium ?? new FakeChromium();
  const clock = timers();
  // a finished download is renamed from its guid on the Host's disk
  const files = { existsSync: () => false, renameSync: o.rename ?? (() => undefined) };
  const host = createBrowserHost({ launch: chromium.launch, downloadsDir: '/host/dl', files, ...clock });
  const state = { alive: true };
  const calls: string[] = [];
  /** the listener each chat's tabs gave the Host */
  const heard = new Map<string, (e: any) => void>();
  const transport = {
    open: (c: string) => (calls.push(`open ${c}`), o.open ? o.open(host, c) : host.open(c)),
    attach: (c: string, t: string) => host.attach(c, t),
    detach: (c: string, t: string) => host.detach(c, t),
    command: (c: string, r: any) => host.command(c, r),
    close: (c: string, t: string) => host.close(c, t),
    release: (c: string) => (calls.push(`release ${c}`), host.release(c)),
    abort: (c: string) => (calls.push(`abort ${c}`), o.abort ? o.abort() : host.abort(c)),
    subscribe: (c: string, fn: any) => (heard.set(c, fn), host.subscribe(c, fn)),
    alive: () => state.alive,
  };
  const aborts = new EventEmitter();
  const tabs = remoteBrowserTabs({
    hostId: o.hostId ?? 'h1',
    transport: o.transport ? o.transport(transport) : transport,
    images: { fromBuffer: (buf: Buffer) => image({ src: 'cdp', bytes: buf.length }) },
    onAbort: (fn: any) => (aborts.on('abort', fn), () => aborts.off('abort', fn)),
    ...(o.hang ? { hang: o.hang } : {}),
    ...(o.pane ? { pane: o.pane } : {}),
  });
  return { t, chromium, host, clock, tabs, transport, state, calls, heard, stop: (c: string) => aborts.emit('abort', c), aborts };
}
export const sent = (w: ReturnType<typeof world>, method: string) => w.chromium.sent(method);
export const changes = (w: ReturnType<typeof world>, c = 'c') => w.tabs.chats.get(c).changes as string[];
