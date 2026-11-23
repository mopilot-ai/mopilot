// Main's end of MoPilot's Chrome native host for tests (electron/capabilities/browser/chromeNativeHost.cjs): a server with fakes for what it asks, and one request on its socket.
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nh = require('../../electron/capabilities/browser/chromeNativeHost.cjs');

/** The store id the extension is installed under in these tests. */
export const STORE = 'abcdefghijklmnopabcdefghijklmnop';

export function request(socket: string, line: string | Buffer, { end = false } = {}) {
  return new Promise<string>((resolve) => {
    const c = net.connect(socket);
    let got = '';
    c.on('data', (d) => (got += d));
    c.on('close', () => resolve(got));
    c.on('error', () => resolve(got));
    c.write(line);
    if (end) c.end();
  });
}

/** A served host on its socket; its stop goes on `stops`. */
export async function hostServer(stops: (() => void)[], o: any = {}) {
  const s = new nh.ChromeNativeHostServer({
    claim: o.claim ?? (() => `mopilot-claim:1:47615:${'c'.repeat(32)}`),
    ids: () => [STORE],
    binary: '/b/sage-mcp',
    verify: o.verify ?? (async () => null),
    lineMs: o.lineMs,
    onRefused: o.onRefused,
    open: o.open,
  });
  stops.push(() => s.stop());
  return { s, socket: await s.start() };
}
