// VM-only glue for the MoPilot 12-Grid Bench (#1381): loads a task's fixtures into the fixture server and its files
// into the task folder, runs the chat through the edge driver (switch, cards, Esc and crash injection), then reads
// back every source the grader needs, what the turn left behind, and the request ledger's lines for the turn.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { magicPath } from '../lib/mgb/apps/account.mjs';
import { describeFile } from '../lib/mgb/files.mjs';
import { initMac as loadMac, macReadScript, macSetupScript, parseMac } from '../lib/mgb/mac.mjs';
import { chatsState } from '../lib/mgb/chats.mjs';
import { providerErrors } from '../lib/mgb/provider.mjs';
import { errorText, escDue } from '../lib/mgb/run.mjs';
import { TOKEN_HEADER } from '../lib/mgb/apps/server.mjs';
import { appWindow, targets, session } from './cdp.mjs';
import { edgeTurn } from './edge.mjs';
import { fixtureTarget, pageContextSource, pendingTaintAnswer, recordTaintCard } from '../lib/mgb/pendingTaint.mjs';
import { isTaintCard } from '../lib/mgb/taintCards.mjs';
import { asUser, screenshot, sleep as pause } from './gui.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const RUNNING = `!!document.querySelector('button.send-btn.stop')`;
/** ~ in a configured path is the VM user's home. @param {string} p */
export const expand = (p) => (p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);

/**
 * A fresh connection for every grader and control call. A native arm's turn (bench/drivers/desktop.mjs) is synchronous
 * and holds the event loop for minutes, so a pooled keep-alive socket the server has since closed is reused after it
 * and the call fails with EPIPE (#1381 native pilot).
 */
const FRESH = { connection: 'close' };

/** The fixture server's grader endpoints. @param {number} port @param {string} token */
export function fixtureServer(port, token) {
  const base = `http://127.0.0.1:${port}`;
  const headers = { [TOKEN_HEADER]: token, host: 'localhost', ...FRESH };
  return {
    /** @param {Record<string, any>} apps */
    async load(apps) {
      const r = await fetch(`${base}/__mgb/load`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ apps }),
      });
      if (!r.ok) throw new Error(`fixture load failed: ${r.status} ${await r.text()}`);
    },
    /** @returns {Promise<Record<string, any>>} */
    state: async () => /** @type {any} */ (await fetch(`${base}/__mgb/state`, { headers }).then((r) => r.json())),
    /** The app hosts the user's Chrome carries the bench mark on. @returns {Promise<string[]>} */
    marks: async () => /** @type {any} */ (await fetch(`${base}/__mgb/marks`, { headers }).then((r) => r.json())).hosts,
  };
}

/** Writes a task's seeded files into its folder (paths were checked by initFiles). @param {string} dir @param {any} fixture */
function placeFiles(dir, fixture) {
  mkdirSync(dir, { recursive: true });
  for (const [p, v] of Object.entries(fixture?.entries ?? {})) {
    const to = path.join(dir, p);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(
      to,
      typeof (/** @type {any} */ (v).base64) === 'string'
        ? Buffer.from(/** @type {any} */ (v).base64, 'base64')
        : String(/** @type {any} */ (v).text ?? ''),
    );
  }
}

/** The task folder as the `files` source: every file below it, described. @param {string} dir */
export function readFiles(dir) {
  /** @type {Record<string, any>} */
  const entries = {};
  const walk = (/** @type {string} */ d) => {
    for (const name of existsSync(d) ? readdirSync(d) : []) {
      if (name === '.DS_Store') continue;
      const full = path.join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.size <= 50 * 1024 * 1024) entries[path.relative(dir, full)] = describeFile(name, readFileSync(full));
    }
  };
  walk(dir);
  return { entries };
}

/** The ledger's lines (#1316) of an instance's user data, from the files of the run's days. @param {string} userData */
export function readLedger(userData) {
  const dir = path.join(expand(userData), 'ledger');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) =>
      readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        }),
    );
}

/** Runs a JXA script in the VM's GUI session (Calendar, Reminders and Notes need it) and returns its result. @param {string} script */
/**
 * A JXA script's result. An app the tidy just quit can time out the first Apple event while it starts (-1712): one
 * retry after it is up.
 * @param {string} script
 */
function jxa(script) {
  try {
    return asUser('osascript', ['-l', 'JavaScript', '-'], script, 300);
  } catch (e) {
    if (!/-1712/.test(String(/** @type {any} */ (e)?.message))) throw e;
    return asUser('osascript', ['-l', 'JavaScript', '-'], script, 300);
  }
}

/** The Mac apps the `mac` source seeds and reads. */
const MAC_APPS = ['Calendar', 'Reminders', 'Notes'];

/**
 * Seeds the bench's Calendar, Reminders and Notes containers. The apps are started first and given time to load: the
 * per-task tidy quits them, and seeding a cold app times out.
 * @param {ReturnType<typeof import('../lib/mgb/mac.mjs').initMac>} mac
 */
function setupMac(mac) {
  for (const app of MAC_APPS) asUser('open', ['-g', '-a', app]);
  pause(4000);
  if (jxa(macSetupScript(mac)) !== 'ok') throw new Error('the Mac apps were not seeded');
}

/** The Chrome profile browser-use tasks run in: a copy of the user's signed-in profile inside the VM (bench/README.md). */
export const CHROME_PROFILE = process.env.MGB_CHROME_PROFILE ?? '~/mgb-scratch-chrome';

/**
 * Signs that Chrome profile in to the account fixture through its one-time link, the only way a session exists, so the
 * in-app browser has none and the task needs the user's Chrome.
 * @param {string} url the link
 */
function signInChrome(url) {
  startBenchChrome(url);
}

/**
 * Starts or hands over to Chrome on the bench profile through the extension pre-launch, in the GUI session. With no
 * URL it stays windowless, so an agent that opens Chrome reaches this instance rather than the VM's default profile.
 * Every start is checked again: the tidy keeps Chrome running, but a task or crash may have quit it.
 * @param {string} [url] a fixture mark or sign-in URL, opened only after the extension runs
 */
export function startBenchChrome(url) {
  asUser(process.execPath, [path.resolve(import.meta.dirname, '../bench-chrome.mjs'), expand(CHROME_PROFILE), '40', ...(url ? [url] : [])]);
}

/**
 * Marks the user's Chrome (the bench profile) for every app: one tab hops through the hosts setting the mark cookie, so
 * the grader can tell that Chrome from any built-in browser. Waits up to 20 s and returns the hosts marked.
 * @param {ReturnType<typeof fixtureServer>} server @param {string} url from run.mjs chromeMarkUrl @param {number} want
 */
export async function markChrome(server, url, want) {
  signInChrome(url);
  let hosts = /** @type {string[]} */ ([]);
  for (let i = 0; i < 20 && hosts.length < want; i++) {
    await sleep(1000);
    hosts = await server.marks();
  }
  // The runner closes this owned mark window before recording; the cookie stays in the configured profile.
  return hosts;
}

/** The provider proxy's control endpoints (bench/mgb-limit-proxy.mjs). @param {number} port @param {string} token */
export function limitProxy(port, token) {
  const call = async (/** @type {string} */ path, /** @type {any} */ body) => {
    const r = await fetch(`http://127.0.0.1:${port}/__limit/${path}`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: token, 'content-type': 'application/json', ...FRESH },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) throw new Error(`the provider proxy refused ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  return {
    arm: (/** @type {string} */ tag, /** @type {number} */ afterRequests) => call('arm', { tag, afterRequests }),
    disarm: () => call('disarm', {}),
    state: () => call('state', {}),
  };
}

/**
 * Renames the chat the app shows, the way a person does (the sidebar row's menu, Rename chat), so another chat can
 * find it by name. @param {string} port @param {string} name
 */
async function renameShownChat(port, name) {
  const app = await appWindow(port);
  const ev = (/** @type {string} */ js) => app.evaluate(js);
  try {
    await ev(
      `(()=>{const r=document.querySelector('[aria-current=page]'); const b=r?.getBoundingClientRect(); r?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:(b?.x??0)+10,clientY:(b?.y??0)+10}))})()`,
    );
    await sleep(500);
    await ev(`[...document.querySelectorAll('[role=menuitem],button')].find(b=>b.innerText.trim()==='Rename chat')?.click()`);
    await sleep(500);
    if (
      !(await ev(
        `(()=>{const i=document.querySelector('input[aria-label="Chat name"]'); if(!i) return false; i.focus(); i.select(); return true})()`,
      ))
    )
      throw new Error(`could not rename the peer chat ${name}`);
    await app.send('Input.insertText', { text: name });
    await ev(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Save')?.click()`);
    await sleep(1000);
  } finally {
    app.close();
  }
}

/** What a turn left behind: the computer-use overlay still shown, or a turn still running. @param {string} port */
async function leaksOf(port) {
  /** @type {string[]} */
  const out = [];
  for (const t of await targets(port).catch(() => [])) {
    // only MoPilot's own windows (the app and its overlay): a web page may have elements with the same ids
    if (t.type !== 'page' || /^(https?|about|chrome):/.test(t.url)) continue;
    const s = await session(t.webSocketDebuggerUrl).catch(() => null);
    if (!s) continue;
    const v = await s
      .evaluate(
        `(()=>{const o=document.getElementById('overlay'); return {overlay: !!(o && document.getElementById('badge') && getComputedStyle(o).opacity==='1'), running: ${RUNNING}}})()`,
      )
      .catch(() => null);
    s.close();
    if (v?.overlay) out.push('the computer-use overlay is still shown');
    if (v?.running) out.push('a turn is still running');
  }
  return [...new Set(out)];
}

/** The sources that are not fixture apps: read from the task folder, the Mac and MoPilot's journal, never loaded. */
const NOT_APPS = new Set(['files', 'mac', 'chats']);

/**
 * Prepares every source of a task before its turn, for MoPilot and the native arms alike: the fixture apps loaded,
 * the seeded files placed, the Mac's containers seeded, and the user's Chrome signed in to the account fixture.
 * @param {{ task: import('../lib/mgb/schema.mjs').Task, fixtures: Record<string, any>, env: import('../lib/mgb/schema.mjs').Env,
 *   server: ReturnType<typeof fixtureServer> }} o
 */
export async function setupSources({ task, fixtures, env, server }) {
  await server.load(Object.fromEntries(Object.entries(fixtures).filter(([k]) => !NOT_APPS.has(k))));
  placeFiles(env.files, fixtures.files);
  if (fixtures.mac) setupMac(/** @type {any} */ (loadMac(fixtures.mac)));
  if (fixtures.account && task.surfaces.includes('bu')) {
    signInChrome(`${env.urls.account.replace(/\/$/, '')}${magicPath(fixtures.account.secret)}`);
    // the run is only fair when the user's Chrome holds the session: without it, a setup error, not the agent's fail
    let signed = false;
    for (let i = 0; i < 20 && !signed; i++) {
      await sleep(1000);
      signed = ((await server.state()).account?.sessions ?? []).some((/** @type {any} */ x) => x.how === 'link');
    }
    if (!signed) throw new Error(`Chrome (${CHROME_PROFILE}) did not sign in to the account fixture`);
  }
}

/**
 * Reads back every source of a task after its turn: the fixture apps' state, the task folder, the Mac's containers and
 * MoPilot's cross-session journal for the turn's window (a native arm has none, so its chats stay empty).
 * @param {{ fixtures: Record<string, any>, env: import('../lib/mgb/schema.mjs').Env, server: ReturnType<typeof fixtureServer>,
 *   userData?: string, window: { from: number, to: number } }} o
 */
export async function collectSources({ fixtures, env, server, userData, window }) {
  const all = await server.state();
  /** @type {Record<string, any>} */
  const state = Object.fromEntries(
    Object.keys(fixtures)
      .filter((k) => all[k])
      .map((k) => [k, all[k]]),
  );
  if (fixtures.files) state.files = readFiles(env.files);
  if (fixtures.chats) {
    const file = userData ? path.join(expand(userData), 'peer-messages.json') : '';
    state.chats = chatsState(file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { messages: [] }, window);
  }
  if (fixtures.mac)
    try {
      state.mac = parseMac(jxa(macReadScript()));
    } catch (e) {
      // the apps are read as the agent left them: closing an open editor first (Esc) drops an event still being made.
      // A read that does not answer keeps the screen beside the task folder, for finding what held the app (#1381)
      try {
        screenshot(`${env.files}.mac-read.png`);
      } catch {
        // no screen to keep: the error still says what failed
      }
      throw new Error(`the Mac apps did not answer the read (screen: ${env.files}.mac-read.png): ${errorText(e)}`);
    }
  return state;
}

/**
 * Read only the pending card's source page and matching form; missing or ambiguous identity denies.
 * @param {string} port @param {import('../lib/mgb/schema.mjs').Env} env @param {any} pending
 */
async function pageContext(port, env, pending) {
  if (!fixtureTarget(pending, env.urls ?? {})) return null;
  const matching = (await targets(port).catch(() => [])).filter(
    (t) => (t.type === 'page' || t.type === 'webview') && t.url === pending.page,
  );
  if (matching.length !== 1) return null;
  const s = await session(matching[0].webSocketDebuggerUrl).catch(() => null);
  if (!s) return null;
  try {
    return await s.evaluate(pageContextSource(pending)).catch(() => null);
  } finally {
    s.close();
  }
}

/**
 * Runs one task on one cell and returns the collected state and the turn.
 * @param {{ task: import('../lib/mgb/schema.mjs').Task, cell: any, port: string, fixtures: Record<string, any>,
 *   prompts: string[], env: import('../lib/mgb/schema.mjs').Env, server: ReturnType<typeof fixtureServer>,
 *   timeoutS: number, shot: string, skipChrome: boolean, peer?: any, data?: any, limiter?: ReturnType<typeof limitProxy>,
 *   tag?: string, userData?: string }} o
 * `peer` is the cell the task's peer chats run on; `limiter` the provider proxy a usage-limit task arms.
 */
export async function mgbTurn({
  task,
  cell,
  port,
  fixtures,
  prompts,
  env,
  server,
  timeoutS,
  shot,
  skipChrome,
  peer,
  data,
  limiter,
  tag,
  userData,
}) {
  await setupSources({ task, fixtures, env, server });
  /** @type {{ escAt?: number, crashedAt?: number, limitedAt?: number | null, limitNotice?: string, taintCards?: { token?: string, how: string, card: string, reason: string | null }[] }} */
  const run = {};
  // the peer chats first, each on the other harness, given its setup message and renamed so the task's chat can find it
  for (const p of task.peers ?? []) {
    const setup = await edgeTurn({
      port,
      cell: peer,
      prompts: [p.prompt(data, env)],
      timeoutS: 180,
      crash: false,
      events: async () => [],
      shot,
      skipChrome,
    });
    if (setup.driverError) throw new Error(`the peer chat ${p.name} did not start: ${setup.error}`);
    await renameShownChat(port, p.name);
  }
  if (task.limit) await /** @type {any} */ (limiter).arm(/** @type {string} */ (tag), task.limit.afterRequests);
  let escMs = /** @type {number | null} */ (null);
  const answers = task.answers ?? [];
  const startedAt = Date.now();
  const turn = await edgeTurn({
    port,
    cell,
    prompts,
    timeoutS,
    crash: false,
    events: async () => Object.values(await server.state()).flatMap((s) => s.events ?? []),
    shot,
    skipChrome,
    switchAt: task.switchBefore ?? 1,
    mode: task.mode ?? 'full',
    // a taint card (G3) is answered by the task's legitimate targets, read from the page its action is on
    answer: async (n, text, pending, token) => {
      if (!task.legitTargets || !isTaintCard(text)) return answers[n] ?? 'allow';
      const context = await pageContext(port, env, pending);
      const how = context ? pendingTaintAnswer(task.legitTargets(data), pending, context) : 'deny';
      recordTaintCard(run, token, text, how, !pending?.url ? 'no-target' : !context ? 'context-unavailable' : null);
      return how;
    },
    tick: async ({ ev, key, message, messageStartedAt }) => {
      const running = await ev(RUNNING).catch(() => true);
      const now = Date.now();
      // only once the provider has refused: before that, the agent's own words about limits are not the notice
      if (task.limit && !run.limitNotice && (await /** @type {any} */ (limiter).state().catch(() => null))?.limitedAt) {
        // what the user is told when the provider refuses: an alert or a notice that names the limit
        const notice = await ev(
          `[...document.querySelectorAll('[role=alert], .browser-notice, .acct-banner, main')].map(e=>e.innerText).join('\\n').match(/[^\\n]*(?:usage limit|limit reached|rate limit)[^\\n]*/i)?.[0] ?? null`,
        ).catch(() => null);
        if (notice) run.limitNotice = String(notice).slice(0, 300);
      }
      if (run.escAt && escMs === null && !running) escMs = now - run.escAt;
      const state = task.escape || task.crash ? await server.state().catch(() => ({})) : {};
      if (escDue(task, { escAt: run.escAt, state, message, messages: prompts.length, messageStartedAt, now })) {
        await key('Escape', 27);
        run.escAt = now;
      }
      if (task.crash && !run.crashedAt) {
        const t = (await targets(port).catch(() => [])).find((x) => {
          try {
            return new URL(x.url).pathname.includes(/** @type {any} */ (task.crash).path);
          } catch {
            return false;
          }
        });
        if (t) {
          const s = await session(t.webSocketDebuggerUrl);
          await s.send('Page.crash', {}, 2000).catch(() => null);
          s.close();
          run.crashedAt = now;
        }
      }
    },
  });
  const endedAt = Date.now();
  await sleep(3000);
  const leaks = await leaksOf(port);
  const state = await collectSources({ fixtures, env, server, userData, window: { from: startedAt, to: endedAt } });
  if (task.limit) run.limitedAt = (await /** @type {any} */ (limiter).disarm().catch(() => null))?.limitedAt ?? null;
  state.run = run;
  const providerErrors = harnessProviderErrors(cell.harness, userData, { from: startedAt, to: endedAt });
  return { state, turn: { ...turn, leaks, escMs, startedAt, endedAt, providerErrors } };
}

/** Where a harness logs its model provider's errors (only opencode's log names them per request today). */
const PROVIDER_LOGS = /** @type {Record<string, string>} */ ({ opencode: '~/.local/share/opencode/log/opencode.log' });

/**
 * The provider errors (rate limits, no answer) a harness logged during the turn for this instance's chats: a run they
 * stopped is UNGRADABLE. The chats are the threads this MoPilot instance wrote in the window (an ACP thread's first
 * line names its harness session). A harness without a known log, or an unreadable one, has none.
 * @param {string} harness @param {string | undefined} userData @param {{ from: number, to: number }} window
 */
function harnessProviderErrors(harness, userData, window) {
  const file = PROVIDER_LOGS[harness];
  if (!file || !userData || !existsSync(expand(file))) return [];
  try {
    const dir = path.join(expand(userData), 'threads');
    const sessions = readdirSync(dir)
      .filter((f) => f.endsWith('.items.jsonl') && statSync(path.join(dir, f)).mtimeMs >= window.from)
      .map((f) => /"sessionId":"([^"]+)"/.exec(readFileSync(path.join(dir, f), 'utf8').slice(0, 2000))?.[1] ?? '')
      .filter(Boolean);
    return providerErrors(readFileSync(expand(file), 'utf8'), { ...window, sessions });
  } catch {
    return [];
  }
}
