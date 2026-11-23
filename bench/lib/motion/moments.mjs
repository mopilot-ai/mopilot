// Motion bench moments (#1511, #3810): the scripted in-between states recorded side by side in each app, as steps the VM recorder plays and regions, relative to the app's front window, that the metrics read; with the agent-cursor moments (fixed distances and directions, repeated clicks, click then type, scroll, idle fade, calibration) driven by prompts over one fixture page.
import { ANGLES, DISTANCES } from './fixture.mjs';

/**
 * A region as fractions of the app's front window: `[x, y, width, height]`, each 0–1.
 * @typedef {[number, number, number, number]} Fraction
 * @typedef {'claude' | 'chatgpt' | 'mopilot'} Family which app's layout a region or step is for
 * @typedef {{ do: 'newChat' } | { do: 'model' } | { do: 'paste', text: string } | { do: 'key', key: 'return' | 'escape' | 'tab', mods?: string }
 *   | { do: 'click', at: [number, number] | Partial<Record<Family, [number, number]>> } | { do: 'wait', ms: number } | { do: 'mark', name: string }} Step
 * @typedef {'cu' | 'iab' | 'bu'} Surface the agent surface a cursor moment is driven on: computer use, the app's own browser, the browser extension
 * @typedef {{ fixture: { plan: 'move', distance: number } | { plan: 'repeat' | 'type' | 'scroll' | 'idle' | 'calibration' }, task: string | null,
 *   tailSeconds?: number }} CursorSpec the fixture page's plan, the task the agent is given, and the stretch recorded after the last action
 * @typedef {{ id: string, title: string, surfaces: string[], seconds: number, steps: Step[], screen?: boolean, cursor?: CursorSpec, app?: boolean,
 *   regions: Record<string, Fraction | Partial<Record<Family, Fraction>> & { default: Fraction }>,
 *   measure: import('./measure.mjs').Measure[] }} Moment
 */

/** The models agent turns use in these recordings: Sonnet 5.5 at Low, and Codex's cheaper model at low (#1511). */
export const MOTION_MODELS = { claude: 'Sonnet 5.5', codex: 'the cheaper Codex model at low effort' };

/** A short prompt that makes a reply with a tool step and a few paragraphs, so the turn shows every state. */
export const TURN_PROMPT =
  'List the files in the current folder with a tool, then write three short paragraphs about what a project like this usually does. No code changes.';

/** A prompt that makes the agent ask before it acts, so an approval card comes up (the app asks in its default mode). */
export const APPROVAL_PROMPT = 'Run the shell command `ls -la` in the current folder, then say how many entries it listed.';

/** A prompt with a long text-only reply, so a queued message, a stop or the reveal land while it streams. */
export const LONG_PROMPT = 'Write five short paragraphs about the history of the bicycle. No tools, no code.';

/** The message sent while that reply streams: the app queues it (or steers with it). */
export const QUEUED_TEXT = 'After that, add one sentence about trains.';

/** A prompt that opens a page in the app's own browser, so its pane, tab and load progress show. */
export const BROWSER_PROMPT =
  "Open https://example.com in your built-in browser and tell me the page's main heading. Use only the browser, no shell.";

/** A prompt for computer use on a Mac app, so the cursor, overlay and its feedback show. */
export const CU_PROMPT =
  'Using computer use, open the Calculator app and compute 12 times 3 by clicking its buttons, then tell me the result.';

/** A prompt whose tool step fails, so the failed row and the reply about it show. */
export const TOOL_ERROR_PROMPT = 'Run the shell command `ls /no-such-folder-1511` and tell me the exact error it printed.';

/** The steps that open a new chat on the recording's model, paste `text` and send it, marking the send. */
const sendSteps = (/** @type {string} */ text) =>
  /** @type {Step[]} */ ([
    { do: 'newChat' },
    { do: 'model' },
    { do: 'paste', text },
    { do: 'wait', ms: 1500 },
    { do: 'mark', name: 'send' },
    { do: 'key', key: 'return' },
  ]);

/** @typedef {Partial<Record<Family, Fraction>> & { default: Fraction }} Regions */
/** @type {Fraction} */
const WHOLE = [0, 0, 1, 1];
/** The composer box (where the send / stop morph shows) and the conversation column. */
/** @type {Regions} */
const COMPOSER = { default: [0.2, 0.78, 0.6, 0.2], chatgpt: [0.25, 0.8, 0.55, 0.17] };
/** @type {Regions} */
const TRANSCRIPT = { default: [0.2, 0.06, 0.6, 0.7], chatgpt: [0.25, 0.08, 0.55, 0.7] };
/** Just above the composer, where a queued message waits. */
/** @type {Regions} */
const TRAY = { default: [0.2, 0.6, 0.6, 0.2], chatgpt: [0.25, 0.62, 0.55, 0.2] };
/** The right half, where each app opens its browser pane beside the chat. */
/** @type {Fraction} */
const PANE = [0.5, 0.04, 0.5, 0.94];

/** @type {Moment[]} */
export const MOMENTS = [
  {
    id: 'turn-start',
    title: 'Send → first visible output → streaming reveal → turn end',
    surfaces: ['transcript', 'composer'],
    seconds: 40,
    steps: [
      { do: 'newChat' },
      { do: 'model' },
      { do: 'paste', text: TURN_PROMPT },
      { do: 'wait', ms: 1500 },
      { do: 'mark', name: 'send' },
      { do: 'key', key: 'return' },
    ],
    regions: {
      // the composer box clears when the message is sent: the trigger seen on screen
      composer: { default: [0.2, 0.78, 0.6, 0.2], chatgpt: [0.25, 0.8, 0.55, 0.17] },
      // the conversation column: the user's bubble, the thinking indicator, steps and the streamed reply
      transcript: { default: [0.2, 0.06, 0.6, 0.7], chatgpt: [0.25, 0.08, 0.55, 0.7] },
    },
    measure: [
      { kind: 'feedback', trigger: 'composer', after: 'send', response: 'transcript' },
      { kind: 'deadAir', region: 'transcript', from: 'send', limitMs: 1000 },
      { kind: 'cadence', region: 'transcript', from: 'send' },
      { kind: 'dropped', region: 'transcript' },
      { kind: 'layoutShift', region: 'transcript' },
    ],
  },
  {
    id: 'approval',
    title: 'An approval card enters, Allow is pressed and released, the card leaves',
    surfaces: ['approval cards'],
    seconds: 40,
    steps: [
      { do: 'newChat' },
      { do: 'model' },
      { do: 'paste', text: APPROVAL_PROMPT },
      { do: 'wait', ms: 1500 },
      { do: 'mark', name: 'send' },
      { do: 'key', key: 'return' },
    ],
    regions: {
      // the card takes the composer's place, a little taller
      card: { default: [0.2, 0.6, 0.6, 0.38], chatgpt: [0.25, 0.62, 0.55, 0.36] },
    },
    measure: [
      { kind: 'transition', region: 'card', after: 'send' },
      { kind: 'dropped', region: 'card' },
    ],
  },
  {
    id: 'steps',
    title: 'A finished turn unfolds its work; one tool row opens and closes',
    surfaces: ['transcript'],
    seconds: 40,
    // recorded on MoPilot over CDP (scripts/motion-cdp/run.mjs --moment steps); the vendor apps' rows are opened by hand
    steps: [
      { do: 'newChat' },
      { do: 'model' },
      { do: 'paste', text: TURN_PROMPT },
      { do: 'wait', ms: 1500 },
      { do: 'mark', name: 'send' },
      { do: 'key', key: 'return' },
    ],
    regions: { transcript: { default: [0.2, 0.06, 0.6, 0.7], chatgpt: [0.25, 0.08, 0.55, 0.7] } },
    measure: [
      { kind: 'transition', region: 'transcript', after: 'expand' },
      { kind: 'transition', region: 'transcript', after: 'collapse' },
      { kind: 'layoutShift', region: 'transcript' },
    ],
  },
  {
    id: 'queue',
    title: 'A message sent while the reply streams waits in the queue, then runs',
    surfaces: ['composer'],
    seconds: 45,
    steps: [
      ...sendSteps(LONG_PROMPT),
      { do: 'wait', ms: 4000 },
      { do: 'paste', text: QUEUED_TEXT },
      { do: 'wait', ms: 800 },
      { do: 'mark', name: 'queue' },
      { do: 'key', key: 'return' },
    ],
    regions: { composer: COMPOSER, tray: TRAY, transcript: TRANSCRIPT },
    measure: [
      { kind: 'feedback', trigger: 'composer', after: 'queue', response: 'tray' },
      { kind: 'transition', region: 'tray', after: 'queue' },
      { kind: 'deadAir', region: 'transcript', from: 'send', limitMs: 1000 },
      { kind: 'dropped', region: 'tray' },
    ],
  },
  {
    id: 'stop',
    title: 'Esc while the reply streams: the turn stops and the composer is ready again',
    surfaces: ['composer', 'transcript'],
    seconds: 30,
    steps: [...sendSteps(LONG_PROMPT), { do: 'wait', ms: 6000 }, { do: 'mark', name: 'stop' }, { do: 'key', key: 'escape' }],
    regions: { composer: COMPOSER, transcript: TRANSCRIPT },
    measure: [
      { kind: 'feedback', trigger: 'stop', response: 'composer' },
      { kind: 'transition', region: 'composer', after: 'stop' },
      { kind: 'deadAir', region: 'transcript', from: 'send', to: 'stop', limitMs: 1000 },
    ],
  },
  {
    id: 'stop-button',
    title: 'The Stop button pressed while the reply streams: its press, the stop and the send button coming back',
    surfaces: ['composer', 'transcript'],
    seconds: 25,
    // points from the window's top left, calibrated on the VM's 2048x1280 screen: ChatGPT's window fills the screen,
    // MoPilot's is its default size; the stop button sits where the send button was
    steps: [
      ...sendSteps(LONG_PROMPT),
      { do: 'wait', ms: 3000 },
      { do: 'mark', name: 'stop' },
      { do: 'click', at: { chatgpt: [1538, 1117], mopilot: [1343, 970] } },
    ],
    regions: { composer: COMPOSER, transcript: TRANSCRIPT },
    measure: [
      { kind: 'feedback', trigger: 'stop', response: 'composer' },
      { kind: 'feedback', trigger: 'stop', response: 'transcript' },
      { kind: 'transition', region: 'composer', after: 'stop' },
    ],
  },
  {
    id: 'browser',
    title: "The agent opens a page in the app's own browser: pane, tab and load progress",
    surfaces: ['browser pane'],
    seconds: 60,
    steps: sendSteps(BROWSER_PROMPT),
    regions: { composer: COMPOSER, pane: PANE, window: WHOLE },
    measure: [
      { kind: 'feedback', trigger: 'composer', after: 'send', response: 'pane' },
      { kind: 'transition', region: 'pane', after: 'send' },
      { kind: 'deadAir', region: 'window', from: 'send', limitMs: 1000 },
      { kind: 'dropped', region: 'window' },
      { kind: 'layoutShift', region: 'pane' },
    ],
  },
  {
    id: 'cu',
    title: 'Computer use on Calculator: cursor, overlay, clicks and the reply',
    surfaces: ['computer use'],
    seconds: 90,
    // the whole screen: the cursor and the overlay move over another app's window
    screen: true,
    steps: sendSteps(CU_PROMPT),
    regions: { screen: WHOLE },
    measure: [
      { kind: 'deadAir', region: 'screen', from: 'send', limitMs: 1000 },
      { kind: 'cadence', region: 'screen', from: 'send' },
      { kind: 'dropped', region: 'screen' },
    ],
  },
  {
    id: 'tool-error',
    title: 'A tool step fails: the failed row and the reply about it',
    surfaces: ['transcript', 'errors'],
    seconds: 35,
    steps: sendSteps(TOOL_ERROR_PROMPT),
    regions: { composer: COMPOSER, transcript: TRANSCRIPT },
    measure: [
      { kind: 'feedback', trigger: 'composer', after: 'send', response: 'transcript' },
      { kind: 'deadAir', region: 'transcript', from: 'send', limitMs: 1000 },
      { kind: 'transition', region: 'transcript', after: 'send' },
      { kind: 'layoutShift', region: 'transcript' },
    ],
  },
];

/** The surfaces a cursor moment runs on, and how the recorder sets each up for the fixture page. */
export const SURFACES = /** @type {Record<Surface, { title: string, launch: string, tool: string }>} */ ({
  cu: {
    title: 'Computer use',
    launch: 'a Chrome app window with no extension, 1280x800 at the top left of the screen (the agent sees only pixels)',
    tool: 'Use computer use only: look at the screen and click with the mouse. Do not use a browser tool, an extension, a shell or scripts. The fixture is the app window titled "Motion fixture" (the app is named Motion fixture) on screen: bring that window to the front if something covers it.',
  },
  iab: {
    title: "The app's built-in browser",
    launch: 'none: the prompt tells the agent to open the page in its own browser pane',
    tool: 'Open {url} in your built-in browser and use only that browser: no computer use, no Chrome, no shell, no scripts, no page JavaScript.',
  },
  bu: {
    title: 'The browser extension (Chrome)',
    launch: "bench/bench-chrome.mjs on a profile with the vendor's extension, the fixture page open in its tab",
    tool: "Use the browser extension in Chrome only, on the open tab titled 'Motion fixture': no computer use, no shell, no scripts, no page JavaScript.",
  },
});

/** The task each fixture plan gives the agent: real multi-step work on the page, reproducible because the page decides the dots. */
export const CURSOR_TASKS = /** @type {Record<string, string>} */ ({
  move: 'The page shows one green dot at a time. Click the center of the dot; the next dot appears somewhere else. Keep clicking each new dot, one click per step, until the page says Done. Then reply with how many dots you clicked.',
  repeat:
    'The page shows one green dot that stays where it is. Click it once per step until the page says Done. Then reply with how many clicks it took.',
  type: 'Click the text field in the middle of the page, type exactly `motion bench 0123`, then press Enter. When the page says Done, reply Done.',
  scroll:
    'Scroll the page down with the mouse wheel until you see the END banner, then scroll back up to the top. When the page says Done, reply Done.',
  idle: 'Click the green dot once, then reply Done and stop. Do nothing after that.',
});

/** MoPilot's extension works only in tabs of its own group, so the agent opens the page itself: the bench's pre-opened tab is not one it can see (#4033). */
export const MOPILOT_BU_TOOL =
  'Use the browser extension in Chrome only: open {url} in a new tab and work on that tab. No computer use, no shell, no scripts, no page JavaScript.';

/** The agent's whole prompt for a cursor moment on a surface; null for a moment with no agent (calibration). `url` is the fixture page's address. */
export function cursorPrompt(
  /** @type {Moment} */ moment,
  /** @type {Surface} */ surface,
  /** @type {string} */ url,
  /** @type {string} */ family = '',
) {
  if (!moment.cursor?.task) return null;
  // MoPilot's own way to work in a granted app is its app-scoped tools (its background cursor); the whole-screen tools check every window at the point, which a screen recorder's own window makes unclickable
  const appScoped =
    family === 'mopilot' && surface === 'cu'
      ? ' Use the app-scoped computer tools (app_screenshot, app_click and the other app_* tools) on the app "Motion fixture", not the whole-screen tools.'
      : '';
  const tool = family === 'mopilot' && surface === 'bu' ? MOPILOT_BU_TOOL : SURFACES[surface].tool;
  return `${tool.replaceAll('{url}', url)}${appScoped} ${moment.cursor.task}`;
}

/** The query string that gives the fixture page a moment's plan. */
export const fixtureQuery = (/** @type {Moment} */ moment) => `?fixture=${encodeURIComponent(JSON.stringify(moment.cursor?.fixture))}`;

/** The windows the cursor moments are measured on: the whole screen, and the corner where a CU overlay or thumbnail updates. */
/** @type {Record<string, Fraction>} */
const CURSOR_REGIONS = { screen: WHOLE, thumb: [0.65, 0.7, 0.35, 0.3] };

/** @param {string} id @param {string} title @param {number} seconds @param {CursorSpec} cursor @returns {Moment} */
function cursorMoment(id, title, seconds, cursor) {
  return {
    id,
    title,
    surfaces: ['agent cursor'],
    seconds,
    screen: true,
    cursor,
    // the prompt is filled in per surface by the recorder ({prompt}); the page decides every position
    steps: cursor.task
      ? [
          { do: 'newChat' },
          { do: 'model' },
          { do: 'paste', text: '{prompt}' },
          { do: 'wait', ms: 1500 },
          { do: 'mark', name: 'send' },
          { do: 'key', key: 'return' },
        ]
      : [
          { do: 'mark', name: 'send' },
          { do: 'wait', ms: (seconds - 5) * 1000 },
        ],
    app: !!cursor.task,
    regions: CURSOR_REGIONS,
    measure: [
      { kind: 'deadAir', region: 'screen', from: 'send', limitMs: 1000 },
      { kind: 'cadence', region: 'thumb', from: 'send' },
      { kind: 'dropped', region: 'screen' },
    ],
  };
}

/**
 * The agent-cursor moments: moves of 30, 100, 200, 400 and 800 px in all eight directions (0 right, clockwise), repeated
 * clicks on one spot, a click then typing, a scroll, the idle fade after the last action, and a calibration with a known
 * moving target and no agent.
 * @type {Moment[]}
 */
export const CURSOR_MOMENTS = [
  ...DISTANCES.map((distance) =>
    cursorMoment(`cursor-move-d${distance}`, `Cursor moves of ${distance} px in ${ANGLES.length} directions`, 300, {
      fixture: { plan: 'move', distance },
      task: CURSOR_TASKS.move,
    }),
  ),
  cursorMoment('cursor-repeat', 'Repeated clicks on one spot', 120, { fixture: { plan: 'repeat' }, task: CURSOR_TASKS.repeat }),
  cursorMoment('cursor-click-type', 'A click into a field, then typing and Enter', 120, {
    fixture: { plan: 'type' },
    task: CURSOR_TASKS.type,
  }),
  cursorMoment('cursor-scroll', 'Scrolling a tall page down and back up', 150, { fixture: { plan: 'scroll' }, task: CURSOR_TASKS.scroll }),
  cursorMoment('cursor-idle-fade', 'The cursor after the last action: when and how it fades', 90, {
    fixture: { plan: 'idle' },
    task: CURSOR_TASKS.idle,
    tailSeconds: 20,
  }),
  cursorMoment('cursor-calibration', 'A target of known speed: what this recorder can see (no agent)', 30, {
    fixture: { plan: 'calibration' },
    task: null,
  }),
];

/** The moment with this id (any catalog); throws naming the known ones. */
export function momentById(/** @type {string} */ id) {
  const all = [...MOMENTS, ...CURSOR_MOMENTS];
  const m = all.find((x) => x.id === id);
  if (!m) throw new Error(`unknown moment ${id}; known: ${all.map((x) => x.id).join(', ')}`);
  return m;
}

/** A moment's steps for one run: `{prompt}` and `{url}` in a paste are filled in. */
export function resolveSteps(/** @type {Moment} */ moment, /** @type {Record<string, string>} */ vars) {
  return moment.steps.map((s) => (s.do === 'paste' ? { ...s, text: s.text.replaceAll(/\{(\w+)\}/g, (all, k) => vars[k] ?? all) } : s));
}

/** The app layout family of a bench arm: the two desktop apps, or MoPilot for every MoPilot arm. */
export function familyOf(/** @type {{ kind: string, app?: string }} */ arm) {
  if (arm.kind === 'mopilot') return 'mopilot';
  if (arm.app === 'Claude') return 'claude';
  if (arm.app === 'ChatGPT') return 'chatgpt';
  throw new Error(`no motion layout for the ${arm.app ?? arm.kind} app`);
}

/**
 * A moment's regions in screen points for one app, from its front window's bounds `[x, y, w, h]`: rounded, the
 * family's own fraction where the moment has one.
 * @param {Moment} moment @param {Family} family @param {[number, number, number, number]} window
 */
export function resolveRegions(moment, family, window) {
  /** @type {Record<string, [number, number, number, number]>} */
  const out = {};
  for (const [name, r] of Object.entries(moment.regions)) {
    const f = Array.isArray(r) ? r : (r[family] ?? r.default);
    out[name] = [
      Math.round(window[0] + f[0] * window[2]),
      Math.round(window[1] + f[1] * window[3]),
      Math.round(f[2] * window[2]),
      Math.round(f[3] * window[3]),
    ];
  }
  return out;
}

/** A click step's point for one app family, or null when the moment has none for it (the step is skipped). */
export function clickPoint(/** @type {Extract<Step, { do: 'click' }>} */ step, /** @type {Family} */ family) {
  return Array.isArray(step.at) ? step.at : (step.at[family] ?? null);
}

/**
 * The measurement spec of one recording: the moment's metrics over its regions moved into the recording's own
 * pixels (the recorder captures only the window, at `pxPerPoint` pixels per point).
 * @param {Moment} moment @param {Record<string, [number, number, number, number]>} regions in screen points
 * @param {[number, number, number, number]} window @param {number} pxPerPoint
 * @returns {import('./measure.mjs').Spec}
 */
export function recordingSpec(moment, regions, window, pxPerPoint) {
  /** @type {Record<string, [number, number, number, number]>} */
  const local = {};
  for (const [name, [x, y, w, h]] of Object.entries(regions)) {
    local[name] = [(x - window[0]) * pxPerPoint, (y - window[1]) * pxPerPoint, w * pxPerPoint, h * pxPerPoint];
  }
  return { id: moment.id, regions: local, measure: moment.measure };
}
