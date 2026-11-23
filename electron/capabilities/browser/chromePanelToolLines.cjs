// What a tool call reads as in Chrome's side panel's step rows, in each of its three states (running, done, failed): the browser and desktop tools' lines, and MoPilot's own tools' (shared/ownToolLines.mjs).
//
// Claude in Chrome words every tool as a triple ("Clicking" / "Clicked" / "Click failed"). Where its triple names the same
// action as ours, the failed line is its own ("Click failed", "Couldn’t type", "Couldn’t scroll"); the done lines are
// MoPilot's (unchanged: "Took a screenshot", "Read the page"), and the running line is the same action in the present
// tense. A call carries no state in a harness that does not say it: it reads as done, as it always has.
const { OWN_LINES } = require('../../../shared/ownToolLines.mjs');
const { toolInvocation } = require('../../../shared/toolInvocation.mjs');

/** @typedef {'running' | 'done' | 'failed'} StepState */

/** One action's lines: what it does while it runs, once done, and when it failed. */
const line = (/** @type {string} */ doing, /** @type {string} */ done, /** @type {string} */ failed) => ({ doing, done, failed });
/** The line of a state. */
const say = (/** @type {{ doing: string, done: string, failed: string }} */ l, /** @type {StepState} */ state) =>
  state === 'running' ? l.doing : state === 'failed' ? l.failed : l.done;

const table = (/** @type {Record<string, ReturnType<typeof line>>} */ o) => Object.assign(Object.create(null), o);
/** Clicks of every kind, as a browser `computer` action or a desktop tool. */
const CLICKS = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'click']);
const CLICK = line('Clicking', 'Clicked', 'Click failed');
/** What a pointer or keyboard action did: a browser `computer` action, or a desktop tool of the same name. */
const ACTIONS = table({
  screenshot: line('Taking a screenshot', 'Took a screenshot', 'Couldn’t take a screenshot'),
  type: line('Typing text', 'Typed text', 'Couldn’t type'),
  key: line('Pressing keys', 'Pressed keys', 'Couldn’t press keys'),
  hold_key: line('Pressing keys', 'Pressed keys', 'Couldn’t press keys'),
  scroll: line('Scrolling', 'Scrolled', 'Couldn’t scroll'),
  scroll_to: line('Scrolling', 'Scrolled', 'Couldn’t scroll'),
  hover: line('Hovering over the page', 'Hovered over the page', 'Couldn’t hover over the page'),
  mouse_move: line('Moving the pointer', 'Moved the pointer', 'Couldn’t move the pointer'),
  zoom: line('Zooming in', 'Zoomed in', 'Couldn’t zoom in'),
  left_click_drag: line('Dragging', 'Dragged', 'Couldn’t drag'),
  drag: line('Dragging', 'Dragged', 'Couldn’t drag'),
  wait: line('Waiting', 'Waited', 'Couldn’t wait'),
});
const PAGE_READ = line('Reading the page', 'Read the page', 'Couldn’t read the page');
const PAGE_SCRIPT = line('Running a script on the page', 'Ran a script on the page', 'Couldn’t run the script');
/** The browser and desktop tools' other steps (each harness's: MoPilot's, Claude in Chrome's), by their name. */
const TOOLS = table({
  tabs_context: line('Checking the open tabs', 'Checked the open tabs', 'Couldn’t check the open tabs'),
  tabs_create: line('Opening a new tab', 'Opened a new tab', 'Couldn’t open a new tab'),
  tabs_close: line('Closing a tab', 'Closed a tab', 'Couldn’t close a tab'),
  tabs_select: line('Switching tabs', 'Switched tabs', 'Couldn’t switch tabs'),
  tabs_mark: line('Keeping a tab open for you', 'Kept a tab open for you', 'Couldn’t keep the tab open'),
  get_page_text: PAGE_READ,
  read_page: PAGE_READ,
  find: line('Searching the page', 'Searched the page', 'Couldn’t search the page'),
  form_input: line('Filling in a field', 'Filled in a field', 'Couldn’t fill in the field'),
  javascript_tool: PAGE_SCRIPT,
  javascript_exec: PAGE_SCRIPT,
  script: PAGE_SCRIPT,
  batch: line('Taking several steps', 'Took several steps', 'Couldn’t take the steps'),
  read_console_messages: line('Reading the console', 'Read the console', 'Couldn’t read the console'),
  read_network_requests: line('Reading network requests', 'Read network requests', 'Couldn’t read network requests'),
  vitals: line('Measuring Web Vitals', 'Measured Web Vitals', 'Couldn’t measure Web Vitals'),
  accessibility_audit: line('Auditing accessibility', 'Audited accessibility', 'Couldn’t audit accessibility'),
  perf_trace: line('Tracing performance', 'Traced performance', 'Couldn’t trace performance'),
  har: line('Recording network traffic', 'Recorded network traffic', 'Couldn’t record network traffic'),
  react: line('Inspecting React', 'Inspected React', 'Couldn’t inspect React'),
  record: line('Recording a video', 'Recorded a video', 'Couldn’t record a video'),
  resize_window: line('Resizing the window', 'Resized the window', 'Couldn’t resize the window'),
  file_upload: line('Uploading a file', 'Uploaded a file', 'Couldn’t upload the file'),
  request_signin: line('Handing the tab to you', 'Handed the tab to you', 'Couldn’t hand over the tab'),
  open_application: line('Opening an app', 'Opened an app', 'Couldn’t open the app'),
  request_access: line('Asking to use apps', 'Asked to use apps', 'Couldn’t ask to use apps'),
});
const PAGE_OPEN = line('Opening a page', 'Opened a page', 'Couldn’t open the page');
const NAVIGATE = table({
  back: line('Going back', 'Went back', 'Couldn’t go back'),
  forward: line('Going forward', 'Went forward', 'Couldn’t go forward'),
  reload: line('Reloading the page', 'Reloaded the page', 'Couldn’t reload the page'),
  stop: line('Stopping the page load', 'Stopped loading the page', 'Couldn’t stop loading the page'),
});

/**
 * A tool's own name, whatever the harness put around it (as the window reads it, src/lib/agentNarration/common.ts
 * controlTool): an MCP prefix (mcp__mopilot_chrome__computer), a namespace (sage.desktop_type), the surface Codex's names
 * carry (chrome_navigate, browser_find, desktop_app_click, the legacy sage_), or Claude in Chrome's _mcp suffix.
 */
function shortTool(/** @type {unknown} */ tool) {
  const parts = (typeof tool === 'string' ? tool : '').split(/__|[./:]/);
  return parts[parts.length - 1].replace(/^(?:sage_)?(?:browser|desktop|chrome)_(?=[a-z])/, '').replace(/_mcp$/, '');
}

/**
 * One of MoPilot's own tools (its server is sage_<nonce>, whichever form the harness wrote the name in) as the app's chat
 * view words it (shared/ownToolLines.mjs): what it did, never the server's nonce and the tool's raw name.
 * @returns {string | null} null for another server's tool, and for one the table has no line for
 */
function ownToolLine(
  /** @type {any} */ item,
  /** @type {string} */ raw,
  /** @type {string | undefined} */ namespace,
  /** @type {StepState} */ state,
) {
  // a basic harness joins server and tool in one name (sage_<nonce>_wrap_up) and names no server
  const joined = item.server ? null : /^sage_[0-9a-f]+_(.+)$/i.exec(raw);
  if (!joined && !/^sage(_|$)/i.test(namespace ?? '')) return null;
  const own = OWN_LINES[joined ? joined[1] : /** @type {string} */ (raw.split(/__|[./:]/).at(-1))];
  return own ? say(own, state) : null;
}

/** A tool call in one short line: what a browser or desktop tool did, else the tool's name. */
function toolLine(/** @type {any} */ item, /** @type {StepState} */ state = 'done') {
  item = toolInvocation(item);
  const raw = typeof item.tool === 'string' ? item.tool : '';
  const namespace =
    typeof item.server === 'string' && item.server ? item.server : (/mcp__(.*?)__/.exec(raw)?.[1] ?? /^[^./:]+(?=[./:])/.exec(raw)?.[0]);
  const own = ownToolLine(item, raw, namespace, state);
  if (own) return own;
  // a basic harness joins MoPilot's server and the tool (sage_<nonce>_chrome_navigate) and names no server: the tool is what follows
  const bare = item.server ? raw : raw.replace(/^sage_[0-9a-f]{12}_/i, '');
  const explicit = /(?:^|__|[./:])(?:sage_)?(?:browser|desktop|chrome)_[a-z]/.test(bare);
  const known = ['mopilot_browser', 'mopilot_chrome', 'mopilot_computer', 'claude-in-chrome', 'browser-use', 'computer-use'];
  if (namespace && !explicit && !known.includes(namespace)) {
    const tool = `${item.server ? `${item.server}/` : ''}${raw}`;
    return state === 'running' ? `Using ${tool}` : state === 'failed' ? `Couldn’t use ${tool}` : `Used ${tool}`;
  }
  const tool = shortTool(bare);
  const a = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
  // the browser's `computer` tool says what it did in its action; a desktop tool (app_click) in its name
  const action = tool === 'computer' ? String(a.action ?? '') : tool.replace(/^app_/, '');
  if (CLICKS.has(action)) return say(CLICK, state);
  if (ACTIONS[action]) return say(ACTIONS[action], state);
  if (tool === 'navigate') {
    const url = String(a.url ?? '');
    const host = URL.canParse(url) ? new URL(url).host : '';
    if (NAVIGATE[url]) return say(NAVIGATE[url], state);
    return host ? say(line(`Opening ${host}`, `Opened ${host}`, `Couldn’t open ${host}`), state) : say(PAGE_OPEN, state);
  }
  if (TOOLS[tool]) return say(TOOLS[tool], state);
  if (tool === 'computer') return say(line('Using the browser', 'Used the browser', 'Couldn’t use the browser'), state);
  if (!tool) return say(line('Using a tool', 'Used a tool', 'Couldn’t use the tool'), state);
  return state === 'running' ? `Using ${tool}` : state === 'failed' ? `Couldn’t use ${tool}` : `Used ${tool}`;
}
/**
 * How far a call has got, from what its harness says: a call that failed (its status, an error, or a result that is one)
 * is `failed`; one the harness still runs is `running`, unless its turn ended some other way than completing (a call cut
 * off by Stop or by a failure runs no more); anything else, and a call with no status, is `done`.
 * @param {any} item @param {boolean} [ended] its turn was stopped or failed
 * @returns {StepState}
 */
function stateOfCall(item, ended = false) {
  // a call with the status `declined` (the user said no) was not run, so it is not a failed one: it reads as it always did
  if (item.status === 'failed' || item.error || item.result?.isError === true) return 'failed';
  return item.status === 'inProgress' && !ended ? 'running' : 'done';
}

module.exports = { toolLine, stateOfCall, say, line };
