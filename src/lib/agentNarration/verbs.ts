// Short past-tense verbs for browser and desktop actions, the words a step group's summary and a batch row are made of.
import { ownTable } from '../../../shared/ownTable.mjs';
import { CLICK, type ControlSurface, type Tenses, type ToolArgs } from './common';
import { pluralize } from '../format';

/**
 * One action's short words, as Claude Desktop's thread lists them ("Clicked", "Captured page"): `key` says which action
 * it is, so equal actions merge by key and never by their (translated) words; `steps` is a named batch's action count;
 * `unknown`: the tables don't know the action, so a step keeps its own narration instead.
 */
export type ControlVerb = { key: string; done: string; doing: string; steps?: number; unknown?: boolean };

/** Claude Desktop's words for the `computer` tool's actions (its renderer's table, read from the shipped bundle). */
const ACTIONS: Record<string, Tenses> = ownTable({
  ...CLICK,
  click: ['Clicked', 'Clicking'],
  screenshot: ['Captured page', 'Capturing page'],
  left_click_drag: ['Dragged', 'Dragging'],
  hover: ['Hovered', 'Hovering'],
  type: ['Typed', 'Typing'],
  key: ['Pressed key', 'Pressing key'],
  hold_key: ['Held key', 'Holding key'],
  scroll: ['Scrolled', 'Scrolling'],
  scroll_to: ['Scrolled to element', 'Scrolling to element'],
  wait: ['Waited', 'Waiting'],
  zoom: ['Zoomed in', 'Zooming in'],
});

/** The browser tools beyond `computer`: Claude Desktop's words where it has them, MoPilot's for its own tools. */
const BROWSER_TOOLS: Record<string, Tenses> = ownTable({
  navigate: ['Opened', 'Opening'],
  navigate_back: ['Went back', 'Going back'],
  read_page: ['Read page', 'Reading page'],
  get_page_text: ['Read page text', 'Reading page text'],
  find: ['Found', 'Finding'],
  form_input: ['Filled in a field', 'Filling in a field'],
  javascript_tool: ['Ran page script', 'Running page script'],
  read_console_messages: ['Read console', 'Reading console'],
  read_network_requests: ['Read network activity', 'Reading network activity'],
  resize_window: ['Resized browser', 'Resizing browser'],
  tabs_context: ['Checked tabs', 'Checking tabs'],
  tabs_create: ['Opened tab', 'Opening tab'],
  tabs_select: ['Switched tabs', 'Switching tabs'],
  tabs_close: ['Closed tab', 'Closing tab'],
  tabs_mark: ['Kept a tab', 'Keeping a tab'],
  file_upload: ['Uploaded file', 'Uploading file'],
  upload_image: ['Uploaded image', 'Uploading image'],
  handle_dialog: ['Answered a dialog', 'Answering a dialog'],
  request_signin: ['Handed the tab to you', 'Handing the tab to you'],
  request_credentials: ['Asked for sign-in details', 'Asking for sign-in details'],
  list_connected_browsers: ['Checked connected browsers', 'Checking connected browsers'],
  select_browser: ['Connected to browser', 'Connecting to browser'],
  gif_creator: ['Recorded page', 'Recording page'],
  press_key: ['Pressed key', 'Pressing key'],
  select_option: ['Chose an option', 'Choosing an option'],
});

/** browser_navigate's moves that open no page. */
const NAVIGATE_MOVES: Record<string, Tenses> = ownTable({
  back: ['Went back', 'Going back'],
  forward: ['Went forward', 'Going forward'],
  reload: ['Reloaded page', 'Reloading page'],
  stop: ['Stopped loading', 'Stopping loading'],
});

/** The desktop tools beyond the shared actions (MoPilot's desktop_* and the computer-use servers' names). */
const DESKTOP_TOOLS: Record<string, Tenses> = ownTable({
  screenshot: ['Captured screen', 'Capturing screen'],
  zoom: ['Zoomed in', 'Zooming in'],
  open_application: ['Opened app', 'Opening app'],
  request_access: ['Asked to use apps', 'Asking to use apps'],
  cursor_position: ['Checked pointer', 'Checking pointer'],
  read_clipboard: ['Read clipboard', 'Reading clipboard'],
  write_clipboard: ['Wrote clipboard', 'Writing clipboard'],
  switch_display: ['Switched display', 'Switching display'],
  focus: ['Switched apps', 'Switching apps'],
  menu: ['Used a menu', 'Using a menu'],
  list_windows: ['Checked windows', 'Checking windows'],
  ax_find: ['Found', 'Finding'],
  release: ['Let go', 'Letting go'],
});

/** Other names for one action, so each action has one key and a summary names it once (fill_form is form_input). */
const SAME_AS: Record<string, string> = ownTable({
  drag: 'left_click_drag',
  mouse_move: 'hover',
  snapshot: 'read_page',
  fill_form: 'form_input',
  javascript_exec: 'javascript_tool',
  evaluate: 'javascript_tool',
  switch_browser: 'select_browser',
  take_screenshot: 'screenshot',
  save_screenshot: 'screenshot',
  wait_for: 'wait',
  release_full_control: 'release',
});

/** A batch's own words: Claude Desktop names at most three different actions, then "+N" for the actions left. */
const BATCH_NAMED = 3;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const listed = (words: string[]) => words.map((w, i) => (i ? lowerFirst(w) : w)).join(', ');

/** A batch tool's own name for its actions' tool (`browser_navigate`, `mcp__x__find`, `tabs_context_mcp`), as the tables read it. */
export function shortToolName(name: unknown): string {
  return String(name ?? '')
    .split(/__|[./:]/)
    .pop()!
    .replace(/^(?:browser|chrome|desktop)_/, '')
    .replace(/_mcp$/, '');
}

/**
 * The words one control action reads as. `name` is the tool's short name (`computer`, `navigate`, `app_click`,
 * `batch`), `args` its arguments; an action the tables don't know reads as using the browser or the computer.
 */
export function controlVerb(name: string, args: ToolArgs, surface: ControlSurface): ControlVerb {
  if (name === 'computer') return controlVerb(String(args.action ?? ''), args, surface);
  if (name === 'batch' || name === 'browser_batch' || name === 'computer_batch' || name === 'app_batch')
    return batchVerb(args, surface, name === 'app_batch');
  // an app-scoped action (app_click) reads as the action, as its row does ("Captured screen in TextEdit")
  const short = name.startsWith('app_') ? name.slice(4) : name;
  const action = SAME_AS[short] ?? short;
  // navigate also goes back, forward, reloads or stops (MoPilot's browser_navigate): those don't open anything
  const moved = action === 'navigate' ? NAVIGATE_MOVES[String(args.url ?? '')] : undefined;
  if (moved) return { key: `${surface}:navigate_${String(args.url)}`, done: moved[0], doing: moved[1] };
  const known = (surface === 'desktop' ? DESKTOP_TOOLS[action] : BROWSER_TOOLS[action]) ?? ACTIONS[action];
  if (known) return { key: `${surface}:${action}`, done: known[0], doing: known[1] };
  // a program (browser_script) is unknown too: its step's narration says what it did
  return surface === 'desktop'
    ? { key: `${surface}:other`, done: 'Used your computer', doing: 'Using your computer', unknown: true }
    : { key: `${surface}:other`, done: 'Used the browser', doing: 'Using the browser', unknown: true };
}

/**
 * A batch call's words, as Claude Desktop's batch row reads: its actions' different verbs in order, at most three,
 * "+N" for the actions past them, and its step count ("Clicked, waited, captured page" in 3 steps).
 */
function batchVerb(args: ToolArgs, surface: ControlSurface, inApp: boolean): ControlVerb {
  const actions = Array.isArray(args.actions) ? (args.actions as unknown[]) : [];
  const toolOf = (raw: unknown) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as ToolArgs;
    return typeof a.name === 'string' ? shortToolName(a.name) : typeof a.tool === 'string' ? shortToolName(a.tool) : String(a.action ?? '');
  };
  // a batch of form inputs (Claude in Chrome's browser_batch) is one fill of several fields, as its row already says
  if (actions.length && actions.every((a) => (SAME_AS[toolOf(a)] ?? toolOf(a)) === 'form_input'))
    return { key: `${surface}:form_input`, done: 'Filled in a field', doing: 'Filling in a field' };
  const named: ControlVerb[] = [];
  let more = 0;
  for (const raw of actions) {
    const a = (raw && typeof raw === 'object' ? raw : {}) as ToolArgs;
    // a browser batch's action is {name, input}; a desktop batch's is the action itself ({action, …})
    const input = (a.input && typeof a.input === 'object' ? a.input : a.args && typeof a.args === 'object' ? a.args : a) as ToolArgs;
    const tool = toolOf(a);
    const v = controlVerb(inApp && !tool.startsWith('app_') ? `app_${tool}` : tool, input, surface);
    if (named.some((n) => n.key === v.key)) continue;
    if (named.length < BATCH_NAMED) named.push(v);
    else more++;
  }
  // no action it can name: the batch keeps its count ("Ran 3 browser actions"), as one action of that size
  if (named.every((n) => n.unknown)) {
    const n = actions.length;
    const key = `${surface}:batch:${n}`;
    return surface === 'desktop'
      ? { key, done: `Ran ${pluralize(n, 'action')}`, doing: `Running ${pluralize(n, 'action')}` }
      : { key, done: `Ran ${pluralize(n, 'browser action')}`, doing: `Running ${pluralize(n, 'browser action')}` };
  }
  const tail = more ? ` +${more}` : '';
  return {
    key: `${surface}:batch:${named.map((n) => n.key).join('+')}${tail}`,
    done: `${listed(named.map((n) => n.done))}${tail}`,
    doing: `${listed(named.map((n) => n.doing))}${tail}`,
    steps: actions.length,
  };
}

/** A batch row's step count, as Claude Desktop's batch row adds it: "in 3 steps". */
export const inSteps = (n: number) => `in ${pluralize(n, 'step')}`;

/**
 * One phrase of a summary: its words, how many calls said them and how many of those failed. `counted`: the words
 * already say how many ("ran 2 commands"), so no "N times" is added.
 */
export type VerbPhrase = { key: string; words: string; count: number; failed: number; counted?: boolean };

/** A run's actions as phrases: equal actions merge in first-seen order, counting calls and failures. */
export function verbPhrases(actions: { verb: ControlVerb; failed: boolean }[]): VerbPhrase[] {
  const phrases: VerbPhrase[] = [];
  for (const { verb, failed } of actions) {
    const p = phrases.find((x) => x.key === verb.key);
    if (p) {
      p.count++;
      p.failed += +failed;
    } else phrases.push({ key: verb.key, words: verb.done, count: 1, failed: +failed });
  }
  return phrases;
}

/**
 * Claude Desktop's group summary: "Checked tabs 2 times", a failed phrase adds "(1 failed)", and past four phrases the
 * first three stay and the rest fold into "and N more actions" (N calls), whose failures follow it (", 1 failed"). The
 * phrases after the first start lower-case.
 */
export function foldPhrases(phrases: VerbPhrase[]): string {
  const said = (p: VerbPhrase) => {
    const words = p.count > 1 && !p.counted ? `${p.words} ${p.count} times` : p.words;
    return p.failed ? `${words} (${p.failed} failed)` : words;
  };
  if (phrases.length < BATCH_NAMED + 2) return listed(phrases.map(said));
  const rest = phrases.slice(BATCH_NAMED);
  const calls = rest.reduce((n, p) => n + p.count, 0);
  const failed = rest.reduce((n, p) => n + p.failed, 0);
  const tail = `and ${pluralize(calls, 'more action')}${failed ? `, ${failed} failed` : ''}`;
  return `${listed(phrases.slice(0, BATCH_NAMED).map(said))}, ${tail}`;
}

/** What a run of control actions did, in Claude Desktop's words ("Clicked, waited, captured page"). */
export const verbSummary = (actions: { verb: ControlVerb; failed: boolean }[]) => foldPhrases(verbPhrases(actions));
