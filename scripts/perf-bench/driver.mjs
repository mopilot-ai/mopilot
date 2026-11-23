// The streaming benchmark's driver: a scratch MoPilot instance on the fake harnesses (its own home, user data and control folder, the probe switched on), and the clicks that make, fill, switch and show its chats.
import fs from 'node:fs';
import { readJsonLineLog } from '../fixture-json-log.mjs';
import { probeFiles } from '../perf-probe-files.mjs';
import path from 'node:path';

/** The harness list's names for each family; the basic harness is the fake ACP agent under Kimi Code's id. */
export const LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', acp: 'Kimi Code' });
export const ACP_ID = 'kimi';

const BENCH = path.dirname(new URL(import.meta.url).pathname);

/** Replay settings for building history: the whole reply in one delta, no gate. */
export const warmSettings = (/** @type {number} */ bytes) => ({ mode: 'replay', bytes, rate: 1_000_000, chunk: bytes, gate: false });

/** Writes the fakes' replay settings for the next turns. */
export function writeSettings(/** @type {string} */ ctl, /** @type {object} */ settings) {
  fs.writeFileSync(path.join(ctl, 'replay.json'), JSON.stringify(settings));
}

/** The control folder's turn events (replay.mjs logEvent). */
export function readEvents(/** @type {string} */ ctl) {
  return readJsonLineLog(path.join(ctl, 'events.jsonl'));
}

/**
 * A scratch profile under `dir`, like the e2e fixture's (tests/e2e/fixtures/app.ts): its own HOME, user data, Codex and
 * Claude Code homes and login shell, the three fakes as the installed harnesses, and the probe switched on.
 * @param {string} dir
 * @param {{ base?: Record<string, string | undefined>, foreground?: boolean, node?: string, env?: Record<string, string> }} [o]
 *   foreground: let windows take focus (a virtual machine, where nobody's work is in front); otherwise background mode
 */
export function prepare(dir, { base = process.env, foreground = false, node = process.execPath, env: extra = {} } = {}) {
  const home = path.join(dir, 'home');
  const userData = path.join(dir, 'userData');
  const ctl = path.join(dir, 'control');
  const codexHome = path.join(home, '.codex');
  const claudeHome = path.join(home, '.claude');
  for (const d of [home, userData, ctl, codexHome, claudeHome]) fs.mkdirSync(d, { recursive: true });
  const codexBin = path.join(BENCH, 'fake-app-server.mjs');
  fs.writeFileSync(
    path.join(userData, 'ui-state.json'),
    JSON.stringify({ codexBin, prefs: { confirmClose: 'never', shareUsageData: false, autoUpdate: false, importSync: false } }),
  );
  // a login shell that exports nothing of the machine's
  const shell = path.join(dir, 'fake-shell');
  fs.writeFileSync(shell, '#!/bin/sh\nfor a; do c=$a; done\nexec /bin/sh -c "$c"\n', { mode: 0o755 });
  const acpBin = path.join(dir, 'acp-bin', ACP_ID);
  fs.mkdirSync(path.dirname(acpBin), { recursive: true });
  fs.writeFileSync(
    acpBin,
    `#!/bin/sh\nexport FAKE_ACP_STATE='${path.join(dir, 'acp-state')}'\nexport FAKE_ACP_PROFILE='{"resume":true}'\nexec "${node}" "${path.join(BENCH, 'fake-acp.mjs')}" "$@"\n`,
    { mode: 0o755 },
  );
  /** @type {Record<string, string>} */
  const env = {};
  for (const k of ['PATH', 'TMPDIR', 'LANG']) if (base[k]) env[k] = /** @type {string} */ (base[k]);
  Object.assign(env, {
    HOME: home,
    MOPILOT_USER_DATA: userData,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_BIN: codexBin,
    CLAUDE_BIN: path.join(BENCH, 'fake-claude.mjs'),
    SAGE_ACP_BINS: JSON.stringify({ [ACP_ID]: acpBin }),
    SHELL: shell,
    FAKE_CLAUDE_AUTH: 'subscription',
    SAGE_NO_RELAY: '1',
    MOPILOT_API: 'http://127.0.0.1:9',
    MOPILOT_FLAGS: 'shared.perf.probe=1',
    PERF_BENCH_CONTROL: ctl,
    ...(foreground ? {} : { SAGE_E2E_BACKGROUND: '1' }),
    ...extra,
  });
  return { env, userData, ctl };
}

/**
 * @param {{ electron: { launch: (o: any) => Promise<any> }, root: string, now?: () => number,
 *           sleep?: (ms: number) => Promise<unknown>, pollMs?: number, log?: (s: string) => void }} o
 *   electron: Playwright's _electron; root: the MoPilot checkout, launched unpackaged (MOPILOT_FLAGS applies only there)
 */
export function createDriver({
  electron,
  root,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 100,
  log = () => undefined,
}) {
  /** Polls until `check` returns something other than undefined, or throws after `ms`. */
  async function until(/** @type {() => Promise<any>} */ check, /** @type {number} */ ms, /** @type {string} */ what) {
    const end = now() + ms;
    for (;;) {
      const v = await check();
      if (v !== undefined) return v;
      if (now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
      await sleep(pollMs);
    }
  }
  const composer = (/** @type {any} */ page) => page.getByRole('textbox', { name: 'Message', exact: true });
  const chatFiles = (/** @type {string} */ userData) => {
    const dir = path.join(userData, 'threads');
    // a chat's record: <id>.v2, or <id>.json as older builds wrote it (electron/platform/chats.cjs)
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(?:v2|json)$/.test(f)) : [];
  };

  const driver = {
    /**
     * Launches the instance on a scratch profile under `dir`.
     * @param {string} dir
     * @param {{ foreground?: boolean, base?: Record<string, string | undefined>, args?: string[], env?: Record<string, string> }} [o]
     *   args: more Chromium switches (the motion capture keeps a background window from being throttled)
     */
    async start(dir, { foreground = false, base = process.env, args = [], env: extra = {} } = {}) {
      const { env, userData, ctl } = prepare(dir, { foreground, base, env: extra });
      const app = await electron.launch({ args: ['--use-mock-keychain', ...args, root], cwd: root, env });
      const page = await app.firstWindow();
      await composer(page).waitFor({ timeout: 60_000 });
      return { app, page, dir, userData, ctl, foreground };
    },

    /** Sends `text` in the chat on screen. */
    async send(/** @type {any} */ s, /** @type {string} */ text) {
      await composer(s.page).fill(text);
      await s.page.getByRole('button', { name: 'Send', exact: true }).click();
    },

    /** Waits for `count` turns to end, counting from `since` (fakes' events), then for the window to be idle. */
    async waitTurns(/** @type {any} */ s, /** @type {number} */ count, /** @type {number} */ since, /** @type {number} */ ms) {
      await until(
        async () => (readEvents(s.ctl).filter((e) => e.kind === 'end' && e.at >= since).length >= count ? true : undefined),
        ms,
        `${count} turns to end`,
      );
      await until(async () => ((await s.page.locator('button.send-btn.stop').count()) === 0 ? true : undefined), ms, 'the chat to be idle');
    },

    /**
     * A new chat on `family` with its first message; returns its id (the chat record main writes for it).
     * @param {any} s
     * @param {'codex' | 'claude' | 'acp'} family
     * @param {string} text
     */
    async newChat(s, family, text) {
      const before = new Set(chatFiles(s.userData));
      await s.page
        .getByRole('button', { name: /^New chat/ })
        .first()
        .click();
      await driver.pickHarness(s, family);
      const since = now();
      await driver.send(s, text);
      await driver.waitTurns(s, 1, since, 120_000);
      const file = await until(async () => chatFiles(s.userData).find((f) => !before.has(f)), 30_000, 'the new chat record');
      const id = decodeURIComponent(file.replace(/\.(?:v2|json)$/, ''));
      // a harness picked before it is ready leaves the chat on the default one: its numbers would carry the wrong label
      const kind = JSON.parse(fs.readFileSync(path.join(s.userData, 'threads', file), 'utf8')).segments?.[0]?.kind;
      if (typeof kind === 'string' && kind.split(':')[0] !== family)
        throw Object.assign(new Error(`chat ${id} started on ${kind}, not ${family}`), { wrongHarness: true });
      log(`chat ${id} on ${family}`);
      return id;
    },

    /** Picks a harness (and its first model) in the composer's harness list. */
    async pickHarness(/** @type {any} */ s, /** @type {'codex' | 'claude' | 'acp'} */ family) {
      // every composer's model button is "Select model": a first-class harness's menu has its harness list behind
      // "Select harness and model", whose rows list that harness's models; a basic harness's menu is the harness list,
      // and a harness picked there starts on its default model
      await s.page.getByRole('button', { name: 'Select model', exact: true }).click();
      const nested = s.page.getByRole('button', { name: 'Select harness and model' });
      await s.page.locator('.hp-harnesses, [aria-label="Select harness and model"]').first().waitFor();
      const viaModels = (await nested.count()) > 0;
      if (viaModels) await nested.click();
      await s.page.locator('.hp-harnesses .hp-row', { hasText: LABELS[family] }).click();
      // the basic harness has no model list
      if (viaModels && family !== 'acp') await s.page.locator('.hp-models .menu-item').first().click();
    },

    /** Switches the chat on screen to `family`, keeping the conversation (the switch sheet's Switch). */
    async switchHarness(/** @type {any} */ s, /** @type {'codex' | 'claude' | 'acp'} */ family) {
      await driver.pickHarness(s, family);
      await s.page.getByRole('button', { name: 'Switch', exact: true }).click();
    },

    /** Shows a chat in the main window, as a notification's click does. */
    async openChat(/** @type {any} */ s, /** @type {string} */ id) {
      const win = await s.app.browserWindow(s.page);
      await win.evaluate(
        (/** @type {any} */ w, /** @type {string} */ chatId) => w.webContents.send('app:command', 'open-chat', chatId),
        id,
      );
      await composer(s.page).waitFor({ timeout: 30_000 });
    },

    /** Opens a second window on a chat. */
    async openWindow(/** @type {any} */ s, /** @type {string} */ id) {
      const count = s.app.windows().length;
      await s.page.evaluate(
        (/** @type {string} */ chatId) => /** @type {any} */ (window).native.win.open(`thread=${encodeURIComponent(chatId)}`),
        id,
      );
      await until(async () => (s.app.windows().length > count ? true : undefined), 30_000, 'the second window');
    },

    /** Brings the main window to the front (only where windows may take focus). */
    async focus(/** @type {any} */ s) {
      if (!s.foreground) return;
      const win = await s.app.browserWindow(s.page);
      await win.evaluate((/** @type {any} */ w) => w.focus());
    },

    /** Quits the instance; returns its probe files, relative to `relativeTo`. */
    async stop(/** @type {any} */ s, /** @type {string} */ relativeTo) {
      await s.app.close();
      const dir = path.join(s.userData, 'perf');
      return probeFiles(s.userData).map((f) => path.relative(relativeTo, path.join(dir, f)));
    },
  };
  return driver;
}
