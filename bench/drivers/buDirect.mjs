// VM-only glue for the browser-use cursor moment (#3810) when the extension path is not available: MoPilot's own AgentCursor (with the Chrome control frame) drives a real Chrome on an isolated scratch profile over CDP, with trusted CDP clicks where the agent's would land. It shows the cursor and frame the Chrome host draws, not the extension or an agent's think time.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bashAsUser } from './gui.mjs';

const require = createRequire(import.meta.url);
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Starts a Chrome on `profile` (a scratch folder named bu-*; never the VM's default profile) with a debugging port, showing `url`.
 * @param {string} profile @param {number} port @param {string} url
 */
export function startDirectChrome(profile, port, url) {
  if (!path.isAbsolute(profile) || !path.basename(profile).startsWith('bu-')) {
    throw new Error(`the direct browser-use run needs a scratch profile folder named bu-*, not ${profile}`);
  }
  const q = (/** @type {string} */ s) => JSON.stringify(s);
  bashAsUser(
    `nohup ${q(CHROME)} --user-data-dir=${q(profile)} --remote-debugging-port=${port} --no-first-run --no-default-browser-check ${q(url)} >/dev/null 2>&1 &`,
    20,
  );
}

/** Quits the Chrome started on `profile`, by the pids whose command line names that profile (never by name). */
export function stopDirectChrome(/** @type {string} */ profile) {
  try {
    const pids = execFileSync('pgrep', ['-f', '--', `--user-data-dir=${profile}`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    for (const pid of pids) process.kill(Number(pid), 'SIGTERM');
  } catch {
    // none left
  }
}

/**
 * Plays the fixture's dots with AgentCursor.act (the cursor arrives, then a trusted CDP click lands), like the Chrome host does.
 * @param {{ port: number, events: any[], thinkMs?: number, timeoutMs?: number }} o `events` is the fixture server's event log
 */
export async function driveBuDirect({ port, events, thinkMs = 700, timeoutMs = 120_000 }) {
  const { chromium } = await import('@playwright/test');
  const { AgentCursor } = require('../../electron/capabilities/browser/agentCursor.cjs');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const deadline = Date.now() + timeoutMs;
  try {
    const page = await (async () => {
      while (Date.now() < deadline) {
        const p = browser
          .contexts()
          .flatMap((/** @type {any} */ c) => c.pages())
          .find((/** @type {any} */ x) => x.url().includes('127.0.0.1'));
        if (p) return p;
        await sleep(300);
      }
      throw new Error('the fixture page never opened in the scratch Chrome');
    })();
    const session = await page.context().newCDPSession(page);
    const tab = { chatId: 'bench', send: (/** @type {string} */ m, /** @type {any} */ p) => session.send(m, p), backend: {} };
    const cursor = new AgentCursor({ frame: true });
    while (!events.some((e) => e.type === 'ready')) await sleep(200);
    const ready = events.find((e) => e.type === 'ready');
    for (const pt of ready.points) {
      if (Date.now() > deadline || events.some((e) => e.type === 'done')) break;
      await cursor.act(tab, { kind: 'click', x: pt.x, y: pt.y, name: 'the dot' });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await session.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      }
      await sleep(thinkMs);
    }
    await cursor.clear(tab);
  } finally {
    await browser.close();
  }
}
