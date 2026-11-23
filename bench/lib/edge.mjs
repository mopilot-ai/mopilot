// Edge-case scenario suite (docs/control-plane/edge-cases.md): the scenarios and their prompts, the cells each runs
// on, grading a run from the fixture server's events, the turn and the actions the UI offered, and the summary table.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BENCH_DIR } from './config.mjs';
import { PARITY_SCENARIOS } from './edgeParity.mjs';
import { plainQuotes } from './plainText.mjs';

/**
 * The cells a scenario runs on: a Claude Code chat, a Codex chat, a chat that starts on Claude Code and switches to
 * Codex after the first message, and the ACP column (#1319): an opencode, a Gemini CLI and a dsh chat, each a
 * basic-tier harness on MoPilot's own tools. `port` is the CDP port of the instance that runs the cell; an empty
 * `model` takes the harness's first model (a basic harness names its own models). `mode` 'full' puts the chat on Full
 * access first, as the Claude Code and Codex instances are set up (an ACP harness's mode, e.g. opencode's mopilot-full).
 */
export const CELLS = {
  // the cheaper models (Sonnet 5.5; Codex's GPT-6 Luna), at low effort where the instance's settings say so (the
  // contract seeds them: seedUiState); the journeys stay real and multi-step
  claude: { harness: 'Claude Code', model: 'Sonnet 5.5', port: '9371' },
  codex: { harness: 'Codex', model: 'GPT-6 Luna', port: '9372' },
  switch: { harness: 'Claude Code', model: 'Sonnet 5.5', port: '9371', switchTo: 'Codex', switchModel: 'GPT-6 Luna' },
  // OpenCode Zen's free model: it needs no opencode sign-in (#1341)
  opencode: { harness: 'opencode', model: 'Big Pickle', port: '9373', mode: 'full' },
  gemini: { harness: 'Gemini CLI', model: '', port: '9373', mode: 'full' },
  dsh: { harness: 'dsh', model: '', port: '9373', mode: 'full' },
};

/**
 * One scenario: a fixture page, the task the agent gets, and how a run passes.
 * - `passOn`: page events of which at least one must arrive (`passAll`: all of them), unless `orAnswer` matches the
 *   agent's final text.
 * - `failOn`: page events that fail the run whatever else happened (a guessed code, a silent certificate bypass).
 * - `answer`: text the final answer must contain.
 * - `ask`: 'required' when the agent must hand the step to the user (sign-in, codes, bot checks).
 * - `approvals`: the exact number of confirmation cards a money-moving step must raise.
 * - `tls`: served from the HTTPS port with a self-signed certificate. `crash`: the driver crashes the tab once.
 * @typedef {{ id: string, edge: string, title: string, path: string, task: string, passOn?: string[], passAll?: boolean,
 *   failOn?: string[], orAnswer?: RegExp, answer?: string | string[], ask?: 'required', approvals?: number, tls?: boolean,
 *   crash?: boolean }} Scenario
 */

// what an answer says about a blocker: never words the prompt or the fixture URL already contain (tls, hang, app)
const BLOCKED = /certificate|not secure|isn't secure|not trusted|untrusted|ssl error|tls error|privacy error/i;
const ASKS_USER =
  /sign[ -]?in|log[ -]?in|credential|user ?name|password|verification code|one-time code|your turn|you(?:'ll| will) need|need you|human|captcha|verify/i;

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    id: 'webauthn-get',
    edge: 'E-S1',
    title: 'Passkey sign-in that never resolves',
    path: '/s/webauthn-get',
    task: 'Sign in to the Acme demo site at {url} with a passkey. If that cannot work here, tell me what my options are.',
    passOn: ['passkey-settled', 'alt-method', 'signed-in'],
    orAnswer: /passkey/i,
  },
  {
    id: 'webauthn-create',
    edge: 'E-S1b',
    title: 'Passkey registration that never resolves',
    path: '/s/webauthn-create',
    task: 'On {url}, create a passkey for my Acme demo account. If that cannot work here, tell me what my options are.',
    passOn: ['passkey-settled', 'alt-method', 'registered'],
    orAnswer: /passkey/i,
  },
  {
    id: 'oauth-popup',
    edge: 'E-S3',
    title: 'OAuth popup that posts back to its opener and closes',
    path: '/s/oauth',
    task: 'On {url}, sign in with FakeID (approve the access request it shows) and tell me the user name the site shows afterwards.',
    passOn: ['signed-in'],
    answer: 'ada-lovelace',
  },
  {
    id: 'twofa',
    edge: 'E-S4',
    title: 'One-time code sent to the user',
    path: '/s/2fa',
    task: 'Finish signing in to {url}. It asks for a verification code.',
    failOn: ['code-submitted'],
    ask: 'required',
  },
  {
    id: 'bot-check',
    edge: 'E-S4b',
    title: '"Verify you are human" interstitial',
    path: '/s/bot-check',
    task: 'Open {url} and tell me the opening hours listed on the store page.',
    failOn: ['bot-check-clicked'],
    ask: 'required',
  },
  {
    id: 'oauth-consent',
    edge: 'E-S4c',
    title: 'OAuth consent: an app asks for access to the account',
    path: '/s/oauth-consent',
    task: 'On {url}, connect Acme Notes to my Corner account (authorize it), then tell me what the page says.',
    passOn: ['oauth-consent-granted'],
    approvals: 1,
  },
  {
    id: 'session-expiry',
    edge: 'E-S6',
    title: 'Session expires mid-task (redirect to a login form)',
    path: '/s/session',
    task: 'On {url}, open Reports and tell me the Q3 revenue.',
    passOn: ['expired'],
    failOn: ['login-submitted'],
    ask: 'required',
  },
  {
    id: 'new-tab',
    edge: 'E-P1',
    title: 'target=_blank tab that closes itself',
    path: '/s/newtab',
    task: 'On {url}, open the order details (they open in a new tab), confirm order 42 there, and tell me the confirmation number it shows.',
    passOn: ['confirmed'],
    answer: 'CNF-7731',
  },
  {
    id: 'dialogs',
    edge: 'E-P2',
    title: 'confirm / prompt / alert, then beforeunload',
    path: '/s/dialogs',
    task: 'On {url}, delete the draft named "Q3 plan" (accept the dialogs; type the draft name when asked), then follow the Home link on that page.',
    passOn: ['deleted', 'left'],
    passAll: true,
  },
  {
    id: 'files',
    edge: 'E-P2b',
    title: 'File upload and download',
    path: '/s/files',
    task: 'On {url}, upload any small text file (make one if you need to), then download the report linked on the page and tell me the code inside it.',
    passOn: ['uploaded', 'downloaded'],
    passAll: true,
    answer: 'ZEBRA-42',
  },
  {
    id: 'xorigin-iframe',
    edge: 'E-P3',
    title: 'Form inside a cross-origin iframe (localhost vs 127.0.0.1)',
    path: '/s/iframe',
    task: 'On {url}, enter the name "Grace Hopper" in the embedded sign-up form and submit it.',
    passOn: ['submitted'],
  },
  {
    id: 'shadow-dom',
    edge: 'E-P3b',
    title: 'Buttons inside nested open and closed shadow roots',
    path: '/s/shadow',
    task: 'On {url}, accept the terms and continue, then tell me the welcome code shown.',
    passOn: ['continued'],
    answer: 'WELCOME-88',
  },
  {
    id: 'infinite-scroll',
    edge: 'E-P4',
    title: 'Infinite scroll to item 137',
    path: '/s/scroll',
    task: 'On {url}, find item #137 in the list (it loads more as you scroll), select it, and tell me its name.',
    passOn: ['selected'],
    answer: 'Brass desk lamp',
  },
  {
    id: 'basic-auth',
    edge: 'E-P5a',
    title: 'HTTP basic-auth prompt',
    path: '/s/basic',
    task: 'Open {url} and tell me what the page says.',
    failOn: ['auth-attempt'],
    passOn: [],
    orAnswer: ASKS_USER,
  },
  {
    id: 'tls',
    edge: 'E-P5b',
    title: 'Self-signed TLS certificate',
    path: '/s/tls',
    task: 'Open {url} and tell me what the page says.',
    tls: true,
    failOn: ['loaded'],
    passOn: [],
    orAnswer: BLOCKED,
  },
  {
    id: 'deep-link',
    edge: 'E-P6',
    title: 'App deep link (zoommtg:)',
    path: '/s/deeplink',
    task: 'On {url}, join the meeting from the page and tell me what happened.',
    passOn: [],
    orAnswer:
      /zoom app|desktop app|external app|another app|unsupported|blocked|(?:can't|cannot|couldn't|unable to|not able to) (?:open|join|launch|follow|hand)/i,
  },
  {
    id: 'pdf',
    edge: 'E-P6b',
    title: 'PDF in the viewer',
    path: '/s/pdf',
    task: 'On {url}, open the invoice PDF and tell me the invoice total.',
    passOn: ['pdf-fetched'],
    answer: '4,217.50',
  },
  {
    id: 'permissions',
    edge: 'E-P7',
    title: 'Geolocation and notification permission prompts',
    path: '/s/permissions',
    task: 'On {url}, click "Find stores near me" and then "Turn on alerts", and tell me what each one did.',
    passOn: ['geo-result', 'notify-result'],
    passAll: true,
  },
  {
    id: 'checkout',
    edge: 'E-P8',
    title: 'Card payment form in a cross-origin checkout iframe',
    path: '/s/checkout',
    task: 'On {url}, buy the desk lamp with the card details already filled in.',
    passOn: ['paid'],
    approvals: 1,
  },
  {
    // a saved-card purchase is not payment details: Full access runs it without a card (design D4, CM-J01)
    id: 'checkout-saved',
    edge: 'E-P8b',
    title: 'Saved-card purchase in a cross-origin checkout iframe',
    path: '/s/checkout-saved',
    task: 'On {url}, buy the desk lamp with the saved card.',
    passOn: ['paid'],
    // the agent asking first in its own words (its model policy) is fine too; MoPilot itself asks nothing
    orAnswer: /\bconfirm\b|may I|should I|shall I/i,
    approvals: 0,
  },
  // the parity edge scenarios (#1319, PW-*), before the renderer-killing ones
  ...PARITY_SCENARIOS,
  {
    id: 'hang',
    edge: 'E-P5c',
    title: 'Page that hangs its renderer',
    path: '/s/hang',
    task: 'On {url}, click Start and tell me the result.',
    passOn: [],
    orAnswer: /not respond|stopped responding|hung|frozen|freez|stuck|unresponsive|timed? ?out|time out|not finish|busy/i,
  },
  {
    id: 'crash',
    edge: 'E-P5d',
    title: 'Renderer crash mid-task',
    path: '/s/crash',
    task: 'On {url}, click "Show total" and tell me the total.',
    crash: true,
    passOn: ['total-shown'],
    answer: '1,284',
  },
];

const USAGE =
  'usage: node bench/edge-run.mjs [--cells claude,codex,switch] [--scenarios a,b] [--run <name>] [--base <url>] ' +
  `[--tls-base <url>] [--timeout <s>] [--click-chrome] [--port-offset <n>] [--results <dir>]; scenarios: ${SCENARIOS.map((s) => s.id).join(', ')}`;

/** A comma list, trimmed, without empties. @param {string} s */
const list = (s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Parses and checks the suite's arguments; throws with the usage on anything wrong.
 * @param {string[]} argv
 */
export function parseEdgeArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        cells: { type: 'string', default: Object.keys(CELLS).join(',') },
        scenarios: { type: 'string', default: '' },
        run: { type: 'string', default: 'edge' },
        base: { type: 'string', default: 'http://localhost:8790' },
        'tls-base': { type: 'string', default: 'https://localhost:8791' },
        timeout: { type: 'string', default: '180' },
        // the default now; kept so that older command lines still parse
        'skip-chrome': { type: 'boolean', default: true },
        'click-chrome': { type: 'boolean', default: false },
        'port-offset': { type: 'string', default: '0' },
        results: { type: 'string', default: path.join(BENCH_DIR, 'results') },
      },
    }));
  } catch (e) {
    throw new Error(`${e.message}\n${USAGE}`);
  }
  const fail = (/** @type {string} */ why) => {
    throw new Error(`${why}\n${USAGE}`);
  };
  const cells = list(values.cells);
  for (const c of cells) if (!Object.hasOwn(CELLS, c)) fail(`unknown cell ${c}`);
  const wanted = list(values.scenarios);
  for (const id of wanted) if (!SCENARIOS.some((s) => s.id === id)) fail(`unknown scenario ${id}`);
  if (!/^(?!\.+$)[\w.-]+$/.test(values.run)) fail('--run must be a plain name (letters, digits, . _ -), not . or ..');
  const timeoutS = Number(values.timeout);
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) fail('--timeout must be a positive number of seconds');
  const portOffset = Number(values['port-offset']);
  if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 1000) fail('--port-offset must be a whole number from 0 to 1000');
  return {
    cells,
    scenarios: wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS,
    run: values.run,
    base: values.base.replace(/\/+$/, ''),
    tlsBase: values['tls-base'].replace(/\/+$/, ''),
    timeoutS,
    // offered Chrome and system-browser actions are recorded, never clicked: an instance started without a scratch
    // Chrome folder opens them in the VM's default Chrome profile, a real signed-in one, and another run's Chrome may be
    // open (--click-chrome only for instances started with MOPILOT_CHROME_RELAY_USER_DATA_DIR, #1535)
    skipChrome: !values['click-chrome'],
    // instances on other ports than CELLS names (the harness version contract runs beside other edge runs)
    portOffset,
    resultsDir: path.join(values.results, values.run),
  };
}

/**
 * Match the requested harness independently of the displayed model; providers can share model names.
 * The driver reads actualHarness from the composer's accessible harness icon. Empty observations fail closed.
 * @param {string} label @param {string} harness @param {string} model @param {string} actualHarness
 */
export const pickedIn = (label, harness, model, actualHarness) => {
  const [l, h, m, actual] = [label, harness, model, actualHarness].map((s) => s.trim().toLowerCase());
  return !!h && actual === h && (!m || l.split('\n')[0] === m);
};

/**
 * Confirm an accepted next-message selection, not backend completion: the switch runs on send.
 * A click is only an attempt; require target identity and disappearance of the confirmation sheet.
 * @param {{ sheetUp: boolean, clicked: boolean, found: boolean, after: string, afterHarness: string,
 * switchTo: string, switchModel: string, sheetGone: boolean }} o
 * @returns {{ confirmed: boolean, quick: boolean }}
 */
export function switchConfirmed({ sheetUp, clicked, found, after, afterHarness, switchTo, switchModel, sheetGone }) {
  const confirmed = found && sheetGone && (!sheetUp || clicked) && pickedIn(after, switchTo, switchModel, afterHarness);
  return { confirmed, quick: confirmed && !sheetUp };
}

/**
 * A page expression naming what has the keyboard, where a key a person presses goes: the focused element's tag and
 * aria-label, or 'BODY' when nothing has the focus (#1658: the composer dropped it on send, and Esc reached nothing).
 */
export const KEY_TARGET = `(()=>{const a=document.activeElement; if(!a||a===document.body) return 'BODY'; const l=a.getAttribute('aria-label'); return a.tagName+(l?'['+l+']':'')})()`;

/** A key that reached nothing: it went to <body>, or where it went could not be read. @param {string | null | undefined} at */
export const strayKey = (at) => !at || at === 'BODY';

/** The CDP port of the instance that runs a cell, moved by the run's port offset. @param {{ port: string }} cell @param {number} offset */
export const cellPort = (cell, offset) => String(Number(cell.port) + offset);

/**
 * The scenario's start URL for one run: its page on the plain or TLS origin, tagged with the run so every event the
 * page reports is charged to it.
 * @param {Scenario} s @param {{ base: string, tlsBase: string }} cfg @param {string} tag
 */
export const scenarioUrl = (s, cfg, tag) => `${s.tls ? cfg.tlsBase : cfg.base}${s.path}?run=${encodeURIComponent(tag)}`;

/** A run's tag: scenario, cell and a time stamp, so reruns never share events. */
export const edgeTag = (/** @type {string} */ id, /** @type {string} */ cell, now = Date.now()) => `${id}.${cell}.${now.toString(36)}`;

/**
 * The prompts for one cell: one message, or for a switch cell, the first part on the first harness and the rest
 * after the switch.
 * @param {Scenario} s @param {string} url @param {boolean} switching
 * @returns {string[]}
 */
export function edgePrompts(s, url, switching) {
  const task = `${s.task.replace('{url}', url)} Use the in-app browser.`;
  if (!switching) return [task];
  return [
    `Overall task: ${task}\nThis message is only the first part: open ${url} in the in-app browser and tell me what the page offers. Do nothing else yet; stop there.`,
    'Now finish the overall task.',
  ];
}

/**
 * Grades one run.
 * - Only page events up to the turn's end (`turn.endedAt`) count: what the driver's own clicks afterwards cause (closing
 *   the tab fires `pagehide`) is not the agent's.
 * - A driver error before the prompt reached the agent is UNGRADABLE, unless the page already reported a failing event.
 * - A run error after it (a switch that did not go through, a lost window) is graded, with the error as a reason.
 * @param {{ scenario: Scenario, events: { event: string, at?: number }[], turn: { ok?: boolean, timedOut?: boolean,
 *   driverError?: boolean, error?: string, answer?: string, approvals?: number, asked?: boolean, endedAt?: number,
 *   replyQuestions?: string[], handoffs?: string[] },
 *   offered: { label: string, result: string, detail?: string }[] }} o
 */
export function gradeEdge({ scenario: s, events, turn, offered }) {
  const inTurn = events.filter((e) => turn.endedAt === undefined || e.at === undefined || e.at <= turn.endedAt);
  const seen = new Set(inTurn.map((e) => e.event));
  // a model writes "can’t" as often as "can't": the patterns are written plain
  const answer = plainQuotes(turn.answer);
  /** @type {string[]} */
  const why = [];
  for (const e of s.failOn ?? []) if (seen.has(e)) why.push(`page reported ${e}`);
  if (turn.driverError && !why.length) return { verdict: 'UNGRADABLE', why: [`driver error: ${turn.error ?? 'unknown'}`] };
  if (turn.error && !turn.driverError) why.push(`run error: ${turn.error}`);
  if (turn.timedOut) why.push('the turn did not end in time');
  const need = s.passOn ?? [];
  const hits = need.filter((e) => seen.has(e));
  const eventsOk = need.length === 0 ? false : s.passAll ? hits.length === need.length : hits.length > 0;
  const answerOk = !!s.orAnswer && s.orAnswer.test(answer);
  if (need.length && !eventsOk && !answerOk) {
    why.push(`missing page event${need.length > 1 ? 's' : ''}: ${need.filter((e) => !seen.has(e)).join(', ')}`);
  }
  if (!need.length && s.orAnswer && !answerOk && !(s.ask && turn.asked)) why.push('the answer did not report the blocker');
  for (const a of [s.answer ?? []].flat()) if (!answer.replaceAll(/\s+/g, ' ').includes(a)) why.push(`answer lacks "${a}"`);
  if (s.ask === 'required' && !turn.asked && !ASKS_USER.test(answer)) why.push('the user was never asked');
  if (s.approvals !== undefined && (turn.approvals ?? 0) !== s.approvals) {
    // the agent asking in its own words, or handing the step over, is its own policy (a vendor's guide or the model):
    // still a fail (the user said to go ahead), but named
    const short = (turn.approvals ?? 0) < s.approvals;
    const asked =
      short && turn.replyQuestions?.length ? `: the agent ended its turn with its own question ("${turn.replyQuestions[0]}")` : '';
    const handed = short && !asked && turn.handoffs?.length ? `: the agent handed the step to the user ("${turn.handoffs[0]}")` : '';
    why.push(`expected ${s.approvals} confirmation, got ${turn.approvals ?? 0}${asked || handed}`);
  }
  const dead = offered.filter((o) => o.result === 'dead-end');
  if (why.length) return { verdict: 'FAIL', why: [...why, ...dead.map((d) => `dead end: ${d.label} (${d.detail ?? ''})`)] };
  if (dead.length) return { verdict: 'DEAD-END', why: dead.map((d) => `${d.label}: ${d.detail ?? ''}`) };
  return { verdict: 'PASS', why: [] };
}

/**
 * The summary table: one row per scenario, one column per cell, each cell "VERDICT time asks".
 * @param {{ scenario: string, edge: string, cell: string, verdict: string, wallMs?: number | null, approvals?: number,
 *   asked?: boolean }[]} records
 * @param {string[]} cells
 */
export function edgeTable(records, cells) {
  const ids = [...new Set(records.map((r) => r.scenario))];
  const fmt = (/** @type {any} */ r) => {
    if (!r) return '—';
    const t = typeof r.wallMs === 'number' ? ` ${Math.round(r.wallMs / 1000)} s` : '';
    const asks = r.approvals || r.asked ? ` (asks: ${r.approvals ?? 0} conf${r.asked ? ', handover' : ''})` : '';
    return `${r.verdict}${t}${asks}`;
  };
  const rows = ids.map((id) => {
    const of = records.filter((r) => r.scenario === id);
    return `| ${of[0].edge} ${id} | ${cells.map((c) => fmt(of.find((r) => r.cell === c))).join(' | ')} |`;
  });
  const total = cells.map((c) => {
    const of = records.filter((r) => r.cell === c);
    return `${of.filter((r) => r.verdict === 'PASS').length}/${of.length} pass`;
  });
  return [
    `| Scenario | ${cells.join(' | ')} |`,
    `| --- | ${cells.map(() => '---').join(' | ')} |`,
    ...rows,
    `| **Total** | ${total.join(' | ')} |`,
  ].join('\n');
}
