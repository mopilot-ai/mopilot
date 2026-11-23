// The Chrome comparison's driver: a separate MoPilot instance per arm (its own user data, opened in the background), one new chat per task, the answer, the cards it answered and the calls MoPilot's operation log saw.
//
// Each arm gets the switches and browser channel of runs.mjs ARMS, and MOPILOT_CHROME_RELAY_USER_DATA_DIR so
// the relay (and Your Chrome) open the scratch profile, never the user's. Cards are answered "Allow" and
// counted. Tool calls come from userData/capabilities/operations.jsonl over the task's time (an instance runs one chat at a time), which records MoPilot's own
// tools only: for the native arm (the vendors' Chrome tools) calls are not counted (null).
// An arm with its own Chrome (the ext arm, ARMS[arm].ownChrome) gets a fresh scratch profile under the output folder with
// MoPilot's extension loaded unpacked from extensionDir (extension.mjs), and its pairings are counted per task.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { callsFromLog } from './metrics.mjs';
import { collectActions } from './actions.mjs';
import { startExtensionChrome } from './extension.mjs';
import { benchFlags } from '../../bench/lib/claudeChrome.mjs';

/** The Chrome executable the scratch profile is opened with (the same default as app/chromeRelay.cjs on macOS). */
export const chromeBin = (env = process.env) =>
  env.MOPILOT_CHROME_RELAY_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The operation log is written in batches (electron/platform/transcriptWriter.cjs, FLUSH_MS 250 ms): a task's last calls are on disk after this. */
const LOG_SETTLE_MS = 750;
/** How long an Allow is held down: longer than the cards that ask to hold (src/components/thread/approvalLogic.ts HOLD_MS). */
export const HOLD_MS = 1200;
/** The Decline of a card asking to let computer use control the Chrome app (Codex's desktop route to Chrome). */
export const DESKTOP_DECLINE = '.approval-card:has-text("Allow Computer Use to use") button:text-is("Decline")';
/** How long a picker step may take: a basic harness lists its models once it has started, a new instance may be busy. */
export const MODELS_MS = 120_000;
/** The picker's row for each harness of run.mjs HARNESSES. */
export const HARNESS_ROWS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' });

/**
 * @param {{ app: string, userDataDir: string, work: string, uploadFile: string, signIn?: string | null, effort?: string | null, extensionDir?: string, actionsHome?: string | null, probe?: ((own: any, phase: 'tick' | 'done') => Promise<void>) | null, extraFlags?: string,
 *           electron: { launch: (o: any) => Promise<any> }, spawn?: typeof nodeSpawn, pollMs?: number, startMs?: number, now?: () => number,
 *           env?: Record<string, string | undefined>, log?: (s: string) => void }} o
 *   app: a MoPilot checkout, launched unpackaged (MOPILOT_FLAGS only applies to an unpackaged build); electron: Playwright's _electron;
 *   startMs: how long a sent message may take to show its turn started; effort: a Codex chat's default reasoning effort;
 *   extensionDir: the built extension (npm run build:chrome-extension) the ext arm loads, by default the app's dist/chrome-extension;
 *   actionsHome: the home folder whose Claude Code and Codex transcripts time each browser call (none: not timed);
 *   extraFlags: MOPILOT_FLAGS switches added to every arm's own (--flags), to compare a switch on and off
 *   probe: called with the arm's own Chrome while a turn runs (phase tick, once per poll) and when it has ended (done), to inspect its tabs
 */
export function electronDriver({
  app,
  userDataDir,
  work,
  uploadFile,
  signIn = null,
  effort = null,
  extensionDir = path.join(app, 'dist', 'chrome-extension'),
  actionsHome = null,
  probe = null,
  extraFlags = '',
  electron,
  spawn = nodeSpawn,
  pollMs = 1000,
  startMs = 30_000,
  now = Date.now,
  env = process.env,
  log = () => undefined,
}) {
  const chrome = (url) => spawn(chromeBin(env), [`--user-data-dir=${userDataDir}`, url], { detached: true, stdio: 'ignore' }).unref();
  return {
    async start(arm, cfg) {
      const userData = path.join(work, `mopilot-${arm}`);
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(
        path.join(userData, 'ui-state.json'),
        JSON.stringify({
          prefs: {
            confirmClose: 'never',
            browserChannel: cfg.channel,
            shareUsageData: false,
            autoUpdate: false,
            // a Codex chat's default reasoning effort (--effort)
            ...(effort ? { effort } : {}),
          },
        }),
      );
      // the scratch profile's Chrome runs before the instance, so the native arm's vendor extensions pair with it
      // (and the signed-in task's account is signed in there); the ext arm's is its own, with the extension loaded
      let profile = userDataDir;
      /** @type {Awaited<ReturnType<typeof startExtensionChrome>> | null} */
      let own = null;
      if (cfg.ownChrome) {
        profile = path.join(work, `chrome-${arm}`);
        own = await startExtensionChrome({
          spawn,
          bin: chromeBin(env),
          userDataDir: profile,
          extensionDir,
          url: signIn ?? 'about:blank',
          log,
        });
      } else chrome(signIn ?? 'about:blank');
      try {
        const instance = await electron.launch({
          args: [app],
          cwd: app,
          env: {
            ...env,
            MOPILOT_USER_DATA: userData,
            // Claude in Chrome off unless the run paired one inside the VM: it can reach a Chrome on another device (#1561)
            MOPILOT_FLAGS: benchFlags([cfg.flags, extraFlags].filter(Boolean).join(','), env),
            MOPILOT_CHROME_RELAY_USER_DATA_DIR: profile,
            SAGE_E2E_BACKGROUND: '1',
          },
        });
        return { arm, userData, instance, own, page: await instance.firstWindow() };
      } catch (e) {
        // the arm never started: its own Chrome does not stay behind
        await own?.close();
        throw e;
      }
    },

    async runTask(session, { harness, model = '', prompt, timeoutMs }) {
      const { page, own } = session;
      const started = now();
      const pairedBefore = (await own?.pairings()) ?? 0;
      // a new instance's first minutes can keep the window busy (importing the harnesses' history): each step waits
      // as long as the model list may (MODELS_MS)
      const wait = { timeout: MODELS_MS };
      await page
        .getByRole('button', { name: /^New chat/ })
        .first()
        .click(wait);
      await page.getByRole('button', { name: 'Select model' }).click(wait);
      await page.getByRole('button', { name: 'Select harness and model' }).click(wait);
      await page.locator('.hp-harnesses .hp-row', { hasText: HARNESS_ROWS[harness] }).click(wait);
      // the model asked for by its name in the picker, else the harness's first. A basic (ACP) harness's row picks it
      // with its last model and closes the picker: its models are then in the model menu, listed once it has started
      // (the first time in a new instance, MODELS_MS)
      const modelButton = page.getByRole('button', { name: 'Select model' });
      if ((await page.locator('.hp-models').count()) > 0)
        await page
          .locator('.hp-models .menu-item', model ? { hasText: model } : {})
          .first()
          .click({ timeout: MODELS_MS });
      else if (model && !(await modelButton.innerText()).includes(model)) {
        await modelButton.click();
        await page.locator('.menu-item', { hasText: model }).first().click({ timeout: MODELS_MS });
      }
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill(`${prompt}\n\nIf you need a file, it is ${uploadFile}.`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      let cards = 0;
      // the turn runs while Stop shows, or a card that took the composer's place (Stop included: it reads "Stop
      // chat" there) waits; every card is allowed (and counted), held down long enough for the cards that ask to hold
      const stop = page.locator('button.send-btn.stop, button.approval-stop');
      const card = page.locator('.approval-card');
      const allow = page.locator('.approval-card button.ap-btn.allow:not(.chevron)');
      // except a card asking to control the Chrome app with the mouse and keyboard (Codex's computer use): that is
      // not the arm's route, so it is declined (and counted) rather than letting the chat drive a desktop window
      const desktop = page.locator(DESKTOP_DECLINE);
      let declined = 0;
      const busy = async () => (await stop.count()) > 0 || (await card.count()) > 0;
      // the turn may take a few seconds to show it started (a harness starting up): wait for that, or for its answer
      const answered = () => page.locator('.assistant-message').count();
      for (let waited = 0; waited < startMs && !(await busy()) && (await answered()) === 0; waited += pollMs) await sleep(pollMs);
      while (await busy()) {
        if (now() - started > timeoutMs) {
          if ((await stop.count()) > 0) await stop.first().click();
          throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`);
        }
        if ((await allow.count()) > 0) {
          cards++;
          await allow.first().click({ delay: HOLD_MS });
        } else if ((await desktop.count()) > 0) {
          declined++;
          await desktop.first().click();
        }
        await probe?.(own, 'tick');
        await sleep(pollMs);
      }
      await probe?.(own, 'done');
      const answers = await page.locator('.assistant-message').allInnerTexts();
      const opLog = path.join(session.userData, 'capabilities', 'operations.jsonl');
      if (session.arm !== 'native') await sleep(LOG_SETTLE_MS);
      const counted =
        session.arm === 'native' || !fs.existsSync(opLog)
          ? { calls: null, invalid: null }
          : callsFromLog(fs.readFileSync(opLog, 'utf8'), { from: started, to: now() });
      // every arm's browser calls timed from the harness's own transcript, one yardstick for all of them
      const actions = actionsHome ? collectActions(harness, { from: started, to: now(), home: actionsHome }) : [];
      // the next task starts with none of this one's tabs, as a user would close them (#1699)
      if (own) await own.closeTabs().catch((e) => log(`ext: closing the task's tabs failed: ${e}`));
      return {
        answer: answers.at(-1) ?? '',
        cards,
        ...counted,
        ...(actions.length ? { actions } : {}),
        ...(own ? { pairings: (await own.pairings()) - pairedBefore } : {}),
        ...(declined ? { declined } : {}),
      };
    },

    async stop(session) {
      try {
        await session.instance.close();
      } finally {
        await session.own?.close();
      }
    },
  };
}
