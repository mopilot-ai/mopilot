// Read native control programs into ordered actions and compact narration.
import { CUA_BROWSER_METHODS, learnCuaBindings, maskCua } from '../../../shared/cuaProgram.mjs';
import { appLabel } from '../appNames';
import {
  q,
  quoted,
  hostOf,
  macKeys,
  CLICK,
  type ControlSurface,
  type ControlStep,
  type NarrationContext,
  type Tenses,
  type ControlCall,
} from './common';
import { pluralize } from '../format';
/** A program with its string literals and comments blanked out (same length), and the literals' values by their opening quote's index. */
type Masked = ReturnType<typeof maskCua>;
const mask = (src: string): Masked => maskCua(src);

const OPEN = '([{';
const CLOSE = ')]}';
/** The index of the bracket that closes the one at `open` (the end of the program when it never closes). */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (OPEN.includes(code[i])) depth++;
    else if (CLOSE.includes(code[i]) && --depth === 0) return i;
  }
  return code.length;
}

/** Where the expression a method is called on starts: `tab.playwright.getByRole(…)` before `.click(`. */
function receiverStart(code: string, dot: number): number {
  let i = dot - 1;
  let prev = '.';
  while (i >= 0) {
    const c = code[i];
    if (/[\w$.?]/.test(c)) prev = c;
    else if (c === ')' || c === ']') {
      let depth = 0;
      for (; i >= 0; i--) {
        if (code[i] === ')' || code[i] === ']') depth++;
        else if ((code[i] === '(' || code[i] === '[') && --depth === 0) break;
      }
      prev = '(';
    } else if (!(/\s/.test(c) && prev === '.')) break; // a chain may continue on the next line
    i--;
  }
  return i + 1;
}

/** The top-level arguments of a call whose parentheses are at `open` and `close`, as [start, end) ranges. */
function argRanges(code: string, open: number, close: number): [number, number][] {
  const out: [number, number][] = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    if (OPEN.includes(code[i])) i = closing(code, i);
    else if (code[i] === ',') {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (code.slice(start, close).trim()) out.push([start, close]);
  return out;
}

/** The string an argument is, when it is a plain literal. */
function argString(m: Masked, r: [number, number] | undefined): string | null {
  if (!r) return null;
  const text = m.code.slice(r[0], r[1]);
  return m.strings.get(r[0] + text.length - text.trimStart().length) ?? null;
}

/** The string an object argument gives a key (`{ name: "Submit" }`). */
function optionString(m: Masked, r: [number, number] | undefined, key: string): string | null {
  if (!r) return null;
  const k = new RegExp(`\\b${key}\\s*:\\s*`).exec(m.code.slice(r[0], r[1]));
  return k ? (m.strings.get(r[0] + k.index + k[0].length) ?? null) : null;
}

/** The element a Playwright locator chain names: `getByRole('button', { name: 'Submit' })` → “Submit”. */
function locatorName(m: Masked, from: number, to: number): string | null {
  const re = /\.\s*(getBy[A-Za-z]+|locator)\s*\(/g;
  re.lastIndex = from;
  let last: RegExpExecArray | null = null;
  for (let x = re.exec(m.code); x && x.index < to; x = re.exec(m.code)) last = x;
  if (!last) return null;
  const open = last.index + last[0].length - 1;
  const args = argRanges(m.code, open, closing(m.code, open));
  if (last[1] === 'getByRole') {
    const name = optionString(m, args[1], 'name');
    if (name) return quoted(name);
    const role = argString(m, args[0]);
    return role ? `a ${q(role, 30)}` : null;
  }
  const s = argString(m, args[0]);
  if (!s) return null;
  if (last[1] !== 'locator') return quoted(s);
  const attr =
    /\[(?:name|aria-label|placeholder|title|id|data-testid)\s*[*^$]?=\s*["']?([^"'\]]+)/.exec(s) ??
    /^#([\w-]+)$/.exec(s) ??
    /text\s*=\s*["']?([^"']+)/.exec(s) ??
    /:has-text\(\s*["']([^"']+)/.exec(s);
  return quoted(attr ? attr[1] : s);
}

/**
 * A program's assignments of apps, browsers and tabs to variables, applied to `into` in order (a
 * reassignment replaces or drops a binding): the same reading main's desktop lock uses (shared/cuaProgram.mjs).
 */
export function learnBindings(code: string, into: NarrationContext) {
  learnCuaBindings(code, into, (app) => q(app, 40));
}

/** One action a program takes; `rank` orders what the program is mostly about. */
interface Action {
  kind: string;
  rank: number;
  surface: ControlSurface | null;
  app: string | null;
  tenses: (surface: ControlSurface, app: string | null) => Tenses;
}

/** Code that runs inside the page: its own clicks and reads are the one "Ran JavaScript" step. */
const PAGE_SIDE = /^(evaluate|evaluateHandle|\$eval|\$\$eval|waitForFunction|addInitScript)$/;
const BROWSER_METHOD =
  /^(goto|reload|goBack|goForward|domSnapshot|nameSession|markHandoff|evaluate|waitForLoadState|waitForSelector|waitForURL)$/;
const BROWSER_CUA = CUA_BROWSER_METHODS;

function where(root: string, method: string, chain: string, ctx: NarrationContext): { surface: ControlSurface | null; app: string | null } {
  const bound = ctx.get(root);
  if (bound) return bound;
  if (root === 'cua')
    return { surface: /^(getApp|listApps)$/.test(method) ? 'desktop' : BROWSER_CUA.test(method) ? 'browser' : null, app: null };
  if (/\.\s*(playwright|keyboard|mouse)\b/.test(chain) || BROWSER_METHOD.test(method) || /tab|page|browser|frame/i.test(root))
    return { surface: 'browser', app: null };
  return { surface: method === 'performSecondaryAction' || /app/i.test(root) ? 'desktop' : null, app: null };
}

const both = (verb: [string, string], rest: string): Tenses => [`${verb[0]}${rest}`, `${verb[1]}${rest}`];
const inAppOr = (app: string | null, otherwise: string) => (app ? ` in ${app}` : otherwise);

function action(
  m: Masked,
  method: string,
  args: [number, number][],
  target: string | null,
  at: { surface: ControlSurface | null; app: string | null },
): Action | null {
  const a = (kind: string, rank: number, tenses: Action['tenses']): Action => ({ kind, rank, ...at, tenses });
  const str = (i: number) => argString(m, args[i]);
  const lastStr = () =>
    args
      .map((r) => argString(m, r))
      .filter((s) => s != null)
      .at(-1) ?? null;
  const open =
    (url: string | null, fresh: boolean): Action['tenses'] =>
    () =>
      url
        ? both(['Opened', 'Opening'], ` ${hostOf(url)}`)
        : fresh
          ? ['Opened a new tab', 'Opening a new tab']
          : ['Opened a page', 'Opening a page'];
  const what = (s: ControlSurface, app: string | null) => target ?? (s === 'browser' ? 'an element' : inAppOr(app, 'on the screen').trim());
  switch (method) {
    case 'createBrowserTab':
      return a('open', 10, open(str(1) ?? (/[./:]/.test(str(0) ?? '') ? str(0) : null), true));
    case 'goto':
      return a('open', 10, open(str(0), false));
    case 'newTab':
    case 'newPage':
    case 'createTab':
      return a('open', 10, open(str(0), true));
    case 'reload':
      return a('open', 9, () => ['Reloaded the page', 'Reloading the page']);
    case 'goBack':
      return a('open', 9, () => ['Went back', 'Going back']);
    case 'goForward':
      return a('open', 9, () => ['Went forward', 'Going forward']);
    case 'getTab': {
      const url = optionString(m, args[0], 'url');
      return a('tab', 2, () => (url ? both(['Switched to', 'Switching to'], ` ${hostOf(url)}`) : ['Switched tabs', 'Switching tabs']));
    }
    case 'getApp': {
      const app = str(0);
      return {
        ...a('app', 2, () => both(['Opened', 'Opening'], ` ${app ? q(appLabel(app), 40) : 'an app'}`)),
        app: app ? q(app, 40) : at.app,
      };
    }
    case 'fill':
    case 'setValue':
      return a('fill', 8, (s, app) => both(['Filled', 'Filling'], ` ${target ?? 'a field'}${s === 'desktop' ? inAppOr(app, '') : ''}`));
    case 'selectOption':
      return a('fill', 8, () => both(['Chose an option', 'Choosing an option'], target ? ` in ${target}` : ''));
    case 'check':
    case 'uncheck':
    case 'setChecked': {
      const off = method === 'uncheck' || (method === 'setChecked' && /^\s*false\b/.test(m.code.slice(...(args[0] ?? [0, 0]))));
      return a('fill', 8, () => both(off ? ['Unchecked', 'Unchecking'] : ['Checked', 'Checking'], ` ${target ?? 'a box'}`));
    }
    case 'type':
    case 'pressSequentially':
    case 'insertText': {
      const n = [...(lastStr() ?? '')].length;
      return a('type', 8, (s, app) =>
        both(['Typed', 'Typing'], ` ${pluralize(n, 'character')}${target ? ` into ${target}` : s === 'desktop' ? inAppOr(app, '') : ''}`),
      );
    }
    case 'click':
    case 'tap':
      return a('click', 7, (s, app) => both(CLICK.left_click, ` ${what(s, app)}`));
    case 'dblclick':
      return a('click', 7, (s, app) => both(CLICK.double_click, ` ${what(s, app)}`));
    case 'performSecondaryAction':
      return a('click', 7, (s, app) => both(CLICK.right_click, ` ${what(s, app)}`));
    case 'press':
    case 'pressKey':
      return a('key', 6, (s, app) => {
        const k = lastStr();
        // a desktop app's keys read as a Mac shows them (⌘N); a page's keys keep their web names
        const shown = k == null ? 'a key' : s === 'desktop' ? macKeys(k) : k;
        return both(['Pressed', 'Pressing'], ` ${q(shown, 40)}${s === 'desktop' ? inAppOr(app, '') : ''}`);
      });
    case 'drag':
    case 'dragTo':
    case 'dragAndDrop':
      return a('drag', 6, (s, app) => both(['Dragged', 'Dragging'], s === 'browser' ? ' on the page' : inAppOr(app, ' on the screen')));
    case 'hover':
      return a('hover', 5, (s, app) =>
        both(['Hovered over', 'Hovering over'], ` ${target ?? (s === 'browser' ? 'an element' : (app ?? 'the screen'))}`),
      );
    case 'scroll':
    case 'wheel':
    case 'scrollIntoViewIfNeeded':
      return a('scroll', 5, (s, app) => both(['Scrolled', 'Scrolling'], s === 'desktop' ? inAppOr(app, '') : ''));
    case 'evaluate':
    case 'evaluateHandle':
    case '$eval':
    case '$$eval':
      return a('script', 5, () => ['Ran JavaScript on the page', 'Running JavaScript on the page']);
    case 'markHandoff':
      return a('handoff', 6, () => ['Handed the tab over to you', 'Handing the tab over to you']);
    case 'close':
      return a('close', 6, (s, app) =>
        s === 'browser' ? ['Closed a tab', 'Closing a tab'] : both(['Closed', 'Closing'], ` ${app ?? 'a window'}`),
      );
    case 'screenshot':
    case 'getScreenshot':
    case 'getAXStateAndScreenshot':
      // the desktop reads as Claude Desktop says it: "Captured screen in Notes" (a run in Notes drops "in Notes")
      return a('screenshot', 4, (s, app) =>
        s === 'desktop' ? both(['Captured screen', 'Capturing screen'], inAppOr(app, '')) : ['Took a screenshot', 'Taking a screenshot'],
      );
    case 'domSnapshot':
    case 'getAXState':
    case 'ariaSnapshot':
    case 'textContent':
    case 'innerText':
    case 'allTextContents':
    case 'allInnerTexts':
    case 'inputValue':
      return a('read', 3, (s, app) =>
        s === 'browser' ? ['Read the page', 'Reading the page'] : both(['Read', 'Reading'], app ? ` the ${app} window` : ' the screen'),
      );
    case 'waitForTimeout':
    case 'waitForSelector':
    case 'waitForLoadState':
    case 'waitForURL':
    case 'waitForFunction':
      return a('wait', 1, () => ['Waited for the page', 'Waiting for the page']);
    case 'getState':
      return a('list', 1, () => ['Checked the open apps and tabs', 'Checking the open apps and tabs']);
    case 'listApps':
      return a('list', 1, () => ['Checked the open apps', 'Checking the open apps']);
    case 'listBrowsers':
      return a('list', 1, () => ['Checked the browsers', 'Checking the browsers']);
    case 'listTabs':
      return a('list', 1, () => ['Checked the open tabs', 'Checking the open tabs']);
    case 'getBrowser':
      return a('list', 1, () => ['Connected to the browser', 'Connecting to the browser']);
    default:
      return null;
  }
}

/** The actions a program takes, in order, skipping code that runs inside the page. */
function scriptActions(m: Masked, ctx: NarrationContext): Action[] {
  const out: Action[] = [];
  let skipTo = -1;
  for (const x of m.code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (x.index < skipTo) continue;
    const method = x[1];
    const open = x.index + x[0].length - 1;
    const close = closing(m.code, open);
    if (PAGE_SIDE.test(method)) skipTo = close;
    const start = receiverStart(m.code, x.index);
    const chain = m.code.slice(start, x.index);
    const root = /^[A-Za-z_$][\w$]*/.exec(chain)?.[0] ?? '';
    const act = action(m, method, argRanges(m.code, open, close), locatorName(m, start, x.index), where(root, method, chain, ctx));
    if (act) out.push(act);
  }
  return out;
}

/**
 * The narration for a control program: what it mostly did and how much else, or its title. `only`: the
 * surface every step is on (a browser_script never leaves the browser).
 */
export function narrateScript(code: string, title: unknown, ctx: NarrationContext, only: ControlSurface | null = null): ControlStep {
  const m = mask(code);
  const local: NarrationContext = new Map(ctx);
  learnBindings(code, local);
  const acts = scriptActions(m, local);
  if (only) for (const x of acts) x.surface = only;
  const primary = acts.reduce<Action | null>((best, x) => (!best || x.rank > best.rank ? x : best), null);
  if (!primary) {
    // nothing it recognises: the surface of any app, browser or tab it uses, and the model's own title
    const surface = [...m.code.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => local.get(x[0])).find(Boolean)?.surface ?? 'desktop';
    const at = only ?? surface;
    const named = typeof title === 'string' && title.trim() ? q(title, 80) : null;
    const awaits = m.code.match(/\bawait\b/g)?.length ?? 0;
    const what = `${at === 'browser' ? 'a browser' : 'a computer-use'} script${awaits > 1 ? ` (${awaits} steps)` : ''}`;
    const app =
      at === 'desktop' ? ([...m.code.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => local.get(x[0])?.app).find(Boolean) ?? null) : null;
    return { surface: at, done: named ?? `Ran ${what}`, doing: named ?? `Running ${what}`, ...(app ? { app } : {}) };
  }
  const surface = primary.surface ?? acts.find((x) => x.surface)?.surface ?? 'desktop';
  const app = primary.app ?? acts.find((x) => x.app)?.app ?? null;
  // what else it did that a person would call a step (reads, screenshots and waits are not)
  const others = acts.filter((x) => x !== primary && x.rank >= 5);
  // the step reads the app's display name; `app` stays as the agent named it (the stack's key)
  const label = app ? appLabel(app) : null;
  let [done, doing] = primary.tenses(surface, label);
  if (primary.kind === 'fill' && others.length && others.every((x) => x.kind === 'fill')) {
    [done, doing] = both(
      ['Filled', 'Filling'],
      ` ${pluralize(others.length + 1, 'field')}${surface === 'desktop' ? inAppOr(label, '') : ''}`,
    );
  } else if (others.length) {
    const more = ` and ${pluralize(others.length, 'more step')}`;
    [done, doing] = [done + more, doing + more];
  }
  return { surface, done, doing, ...(surface === 'desktop' && app ? { app } : {}) };
}

/** Codex's native browser and computer use: cua_repl runs one JavaScript program per call. */
export function cuaStep(c: ControlCall, ctx: NarrationContext): ControlStep | null {
  if (c.tool === 'js_reset') return { surface: 'desktop', done: 'Reset the control session', doing: 'Resetting the control session' };
  if (c.tool === 'turn_ended') return { surface: 'desktop', done: 'Let go of your computer', doing: 'Letting go of your computer' };
  if (c.tool !== 'js') return null;
  return narrateScript(typeof c.args.code === 'string' ? c.args.code : '', c.args.title, ctx);
}
