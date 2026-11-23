// The Mac's half of MoMo's Google sign-in: a one-shot loopback listener on 127.0.0.1 (an OS-picked port) that catches the browser's redirect and hands it, with the state it carried, to the sign-in flow (shared/momoGoogle/signIn.mjs); the code is then sealed to the home's key and this process forgets it. Anything but the one GET /callback with a state and a code or error is answered 400/404 and the wait goes on until its timeout.
const nodeHttp = require('node:http');
const { parseCallback } = require('../../shared/momoGoogle/handoff.mjs');

const WAIT_MS = 5 * 60_000;
const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>MoPilot</title><p>You can close this tab and return to MoPilot.</p>';

/**
 * @param {object} o
 * @param {(url: string) => unknown} o.openExternal opens the consent page in the system browser
 * @param {number} [o.timeoutMs]
 * @param {Pick<typeof nodeHttp, 'createServer'>} [o.http]
 * @returns {() => Promise<import('../../shared/momoGoogle/signIn.mjs').Catcher>}
 */
function createLoopbackCatcher({ openExternal, timeoutMs = WAIT_MS, http = nodeHttp }) {
  return () =>
    new Promise((resolveStart, rejectStart) => {
      /** @type {(h: import('../../shared/momoGoogle/handoff.mjs').Handoff | null) => void} */
      let resolveWait;
      const waited = new Promise((resolve) => {
        resolveWait = resolve;
      });
      let redirectUri = '';
      /** The state of the consent page this catcher opened: only a redirect that carries it is the sign-in's, so a web page poking at 127.0.0.1 changes nothing. @type {string | null} */
      let expected = null;
      let settled = false;
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const finish = (/** @type {import('../../shared/momoGoogle/handoff.mjs').Handoff | null} */ hand) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        resolveWait(hand);
      };
      const server = http.createServer((req, res) => {
        if (settled) return void res.writeHead(410).end();
        const url = new URL(/** @type {string} */ (req.url), 'http://127.0.0.1');
        if (req.method !== 'GET' || url.pathname !== '/callback') return void res.writeHead(404).end();
        const hand = parseCallback(/** @type {string} */ (req.url), redirectUri);
        if (!hand || hand.state !== expected) return void res.writeHead(400).end();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(DONE_PAGE);
        finish(hand);
      });
      server.once('error', rejectStart);
      server.listen(0, '127.0.0.1', () => {
        const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
        redirectUri = `http://127.0.0.1:${addr.port}/callback`;
        timer = setTimeout(() => finish(null), timeoutMs);
        timer.unref();
        resolveStart({
          redirectUri,
          open: async (url) => {
            expected = new URL(url).searchParams.get('state');
            await openExternal(url);
          },
          wait: () => /** @type {Promise<any>} */ (waited),
          close: () => finish(null),
        });
      });
    });
}

module.exports = { createLoopbackCatcher, WAIT_MS };
