// The benchmark VM's GUI session, from inside the VM: run a command as the logged-in user, press keys, click at
// screenshot coordinates (1200 px wide space, scaled to the screen), paste text, and take screenshots.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromeCleanupPlan, chromeCleanupScript } from '../lib/chromeCleanup.mjs';
import { appleString, frontFailure, guardedScript } from '../lib/frontGuard.mjs';
import { focusTextAreaScript } from '../lib/composerFocus.mjs';
import { moveWindowLines } from '../lib/motion/layout.mjs';

const UID = process.env.BENCH_GUI_UID ?? '501';
const CLICLICK = process.env.BENCH_CLICLICK ?? '/opt/homebrew/bin/cliclick';

/**
 * Runs a command in the GUI user's session (osascript, cliclick and pbcopy need it). Throws on failure.
 * @param {string} cmd @param {string[]} [args] @param {string} [input]
 */
export function asUser(cmd, args = [], input = undefined, timeoutS = 120) {
  return execFileSync('launchctl', ['asuser', UID, cmd, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 32 << 20,
    timeout: timeoutS * 1000,
  }).trim();
}

/** Runs a bash script in the GUI session with a time limit; never throws, returns its output. */
export function bashAsUser(/** @type {string} */ script, timeoutS = 120) {
  try {
    return asUser('perl', ['-e', `alarm ${timeoutS}; exec @ARGV`, 'bash', '-s'], script, timeoutS + 5);
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  }
}

export const sleep = (/** @type {number} */ ms) => execFileSync('sleep', [String(ms / 1000)]);

/**
 * The app the driver last brought to the front. Keys and clicks go only to it: when another app is in front (a person
 * signing in on the VM's screen, a dialog), they throw NotFrontmost and send nothing (#1561).
 */
let target = '';

/**
 * Runs a System Events command (none: only the check) once the target app is the frontmost process, in the same call.
 * @param {string} [action]
 */
export function toFront(action = '') {
  if (!target)
    throw Object.assign(new Error('No app was brought to the front: activate one before sending keys or clicks.'), { code: 'no_target' });
  try {
    return asUser(
      'osascript',
      guardedScript(target, action).flatMap((line) => ['-e', line]),
    );
  } catch (e) {
    throw frontFailure(target, e);
  }
}

/** A key by macOS key code, with modifiers like "command down", to the app in front (see toFront). */
export const key = (/** @type {number} */ code, mods = '') => toFront(`key code ${code}${mods ? ` using {${mods}}` : ''}`);

/** Types text as keystrokes into the app in front (see toFront). */
export const keystroke = (/** @type {string} */ text) => toFront(`keystroke ${appleString(text)}`);

/** Brings an app to the front by its name; later keys and clicks go only to it. */
export function activate(/** @type {string} */ app) {
  target = app;
  return asUser('osascript', ['-e', `tell application ${appleString(app)} to activate`]);
}

/** Brings a process to the front by its process name (a dev build runs as "Electron"); later keys and clicks go only to it. */
export function focusProcess(/** @type {string} */ name) {
  target = name;
  return asUser('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first process whose name is ${appleString(name)} to true`,
  ]);
}

let scale = 0;
/** Clicks at screenshot coordinates: the desktop's width in points over the 1200 px screenshot. */
export function click(/** @type {number} */ x, /** @type {number} */ y) {
  if (!scale)
    scale = Number(asUser('osascript', ['-e', 'tell application "Finder" to get item 3 of (get bounds of window of desktop)'])) / 1200;
  clickAt(x * scale, y * scale);
}

/** The main screen as [x, y, width, height] in points (the desktop's bounds). */
export function screenBounds() {
  const b = asUser('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']).split(',').map(Number);
  return [b[0], b[1], b[2] - b[0], b[3] - b[1]];
}

/**
 * The front window of the app the driver brought to the front, as [x, y, width, height] in screen points, read in the
 * same call that checks it is in front (see toFront).
 */
export function frontWindowBounds() {
  return toFront('get {position, size} of window 1 of p')
    .split(',')
    .map((v) => Number(v.trim()));
}

/** Moves and resizes window 1 of a process to [x, y, w, h] in screen points; it need not be in front (it is no key or click). */
export function moveAppWindow(/** @type {string} */ processName, /** @type {number[]} */ bounds) {
  return asUser(
    'osascript',
    moveWindowLines(processName, bounds).flatMap((line) => ['-e', line]),
  );
}

/**
 * How many sheets the front app's front window has (a Save or Open sheet, read in the same call that checks the app is
 * in front, see toFront). A sheet covers whatever card the window shows.
 */
export function frontSheetCount() {
  let out;
  try {
    out = toFront('count of sheets of window 1 of p');
  } catch (e) {
    // another app in front is the caller's refusal; no window to read (or any other AppleScript failure) is unknown
    if (e?.code === 'not_frontmost') throw e;
    return 1;
  }
  // an answer that is not a count is unknown too, and unknown is treated as covered: nothing is sent into it
  return /^\d+$/.test(out) ? Number(out) : 1;
}

/**
 * Clicks at screen points, right after checking that the app the driver brought to the front is still in front (see
 * toFront). cliclick runs as its own process, so unlike a key the click follows the check by a few milliseconds.
 */
export function clickAt(/** @type {number} */ x, /** @type {number} */ y) {
  toFront();
  asUser(CLICLICK, [`c:${Math.round(x)},${Math.round(y)}`]);
}

/** Puts text on the GUI user's clipboard. */
export const copy = (/** @type {string} */ text) => asUser('pbcopy', [], text);

/** A paste that was not sent because the clipboard no longer held the text put on it (#4376). */
export class ClipboardChanged extends Error {
  constructor() {
    super('The clipboard did not hold the text to paste, so nothing was pasted.');
    this.code = 'clipboard_changed';
    this.front = 'the clipboard changed';
  }
}

/**
 * Pastes text into the focused field of the app in front. The clipboard is set here, not earlier, and read back first:
 * the VM can share its clipboard with the host, so what was copied seconds ago may be someone else's text by now, and
 * Cmd+V would send that (#4376). The clipboard is emptied afterwards, so the text does not stay on it.
 * @param {string} text
 */
export function paste(text) {
  copy(text);
  try {
    // read without trimming: the text itself may end in a newline
    const held = execFileSync('launchctl', ['asuser', UID, 'pbpaste'], { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 30_000 });
    if (held !== text) throw new ClipboardChanged();
    key(9, 'command down');
    sleep(500);
  } finally {
    copy('');
  }
}

/** Saves a 1200 px wide screenshot of the screen. */
export function screenshot(/** @type {string} */ file) {
  asUser('/usr/sbin/screencapture', ['-x', file]);
  execFileSync('sips', ['-Z', '1200', file], { stdio: 'ignore' });
}

/**
 * Asks an Electron app for its full Accessibility tree. Electron builds the tree only for a client that asks, and the
 * request is lost when the app restarts (a VM reboot), so a walk without it finds no rows. Best effort.
 * @param {string} app the process name
 */
export function enableAccessibility(app) {
  try {
    asUser('osascript', [
      '-e',
      `tell application "System Events" to set value of attribute "AXManualAccessibility" of process "${app}" to true`,
    ]);
    execFileSync('sleep', ['1']);
  } catch {
    // not an Electron app, or not running: the walk finds what it finds
  }
}

/**
 * Puts the keyboard focus in an app's first text area (a chat app's composer) through the Accessibility tree, for when
 * a key press cannot reach it (computer use left focus elsewhere). Slow (the tree is walked, up to a minute); returns
 * whether one was found.
 * @param {string} app the process name
 */
export function focusTextArea(app) {
  enableAccessibility(app);
  const script = focusTextAreaScript(app);
  try {
    return asUser('osascript', ['-l', 'JavaScript', '-'], script, 120) === 'ok';
  } catch {
    return false;
  }
}

/** The apps a task can leave windows in: quit before each task so none starts on another task's leftovers. */
export const TIDY_APPS = ['TextEdit', 'Preview', 'Calendar', 'Reminders', 'Notes', 'Safari', 'System Settings'];
/**
 * Where an app's Open/Save panel remembers the last folder: the sandboxed apps' container plist and the plain domain,
 * under the current key (`NSOSPLastRootDirectory`) and the older one, all reset between tasks.
 */
const SAVE_PANEL_PREFS = ['TextEdit', 'Preview'].flatMap((app) => [
  `${process.env.HOME}/Library/Containers/com.apple.${app}/Data/Library/Preferences/com.apple.${app}`,
  `com.apple.${app}`,
]);
const SAVE_PANEL_KEYS = ['NSOSPLastRootDirectory', 'NSNavLastRootDirectory'];

/** What a dialog left by a task is answered with, in this order: never save, never keep a download, else cancel. */
const ANSWERS = ['Don\u2019t Save', "Don't Save", 'Delete', 'Quit', 'Cancel'];

/**
 * Puts the desktop back to a clean start between tasks (#1381). A leftover panel otherwise holds the keyboard, and the
 * next task's message is typed into it. Each step is bounded, so a dialog can never hang the tidy:
 * 1. every dialog and sheet of a task app is answered through System Events (Don't Save, Quit or Cancel), so
 *    no app is left waiting on one;
 * 2. the task apps are asked to quit;
 * 3. one that is still running is stopped (SIGTERM, then SIGKILL), and TextEdit's and Preview's restored windows and
 *    autosaved drafts are removed, so the next launch does not bring another task's document back;
 * 4. Finder's sheets are dismissed and its windows closed (Info windows too), and one left open is reported;
 * 5. only the explicitly configured bench Chrome PIDs are cleaned; another profile blocks browser-use setup;
 * 6. files a task saved or downloaded on the Desktop, in Documents or in Downloads are moved to ~/mgb-leftovers, so
 *    no later task finds another run's files there (one that cannot move is reported);
 * 7. any other app with a window open (one an agent opened) is quit, and one still open is reported.
 * Agent apps are never sent Esc here: twice in a row opens Claude Desktop's Rewind. Returns what is still not clean.
 */
export function tidyDesktop(chromeProfile = '') {
  const chrome = chromeProfile ? tidyBenchChrome(chromeProfile) : [];
  const apps = JSON.stringify(TIDY_APPS);
  jxaBounded(`const se=Application('System Events');const A=${JSON.stringify(ANSWERS)};
for (const n of ${apps}) { if (!se.processes.whose({name:n})().length) continue;
  for (const w of se.processes.byName(n).windows()) { const places=[w]; try { places.push(...w.sheets()); } catch(e) {}
    for (const p of places) { let bs=[]; try { bs=p.buttons(); } catch(e) {}
      const b=A.map((a)=>bs.find((x)=>{ try { return x.name()===a; } catch(e) { return false; } })).find(Boolean); if (b) try { b.click(); } catch(e) {} } } }
'ok'`);
  jxaBounded(`const se=Application('System Events');
for (const n of ${JSON.stringify(TIDY_APPS)}) if (se.processes.whose({name:n})().length) try { Application(n).quit(); } catch(e) {}
'ok'`);
  for (const name of TIDY_APPS.filter(isRunning)) stopApp(name);
  for (const dir of RESTORED_STATE)
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // nothing restored
    }
  // a Save panel opens where the last task saved (another task's folder): every task starts from Documents
  for (const domain of SAVE_PANEL_PREFS)
    for (const k of SAVE_PANEL_KEYS)
      try {
        execFileSync('launchctl', ['asuser', UID, 'defaults', 'delete', domain, k], { stdio: 'ignore' });
      } catch {
        // never set: already the default
      }
  // Finder is never quit: a window held by a sheet (Go to Folder) cannot close until the sheet is dismissed, and an Info
  // window is not one of Finder's scripting windows, so each is closed by its close button
  settleApps(['Finder']);
  const finder = jxaBounded(`const p=Application('System Events').processes.byName('Finder');
for (let round=0; round<5 && p.windows().length; round++) {
  for (const w of p.windows()) try { const b=w.buttons().find((x)=>{ try { return x.subrole()==='AXCloseButton'; } catch(e) { return false; } }); if (b) b.click(); } catch(e) {}
  delay(1);
}
p.windows().map((w)=>{ let n='', r=''; try { n=w.name(); r=w.subrole(); } catch(e) {} return n+' ('+r+')'; }).join(', ')`);
  const stuck = clearUserFolders();
  // an app an agent opened beyond the task apps (Mail, Photos) is quit the same way, then stopped
  for (const name of otherWindows() ?? []) {
    jxaBounded(`try { Application(${JSON.stringify(name)}).quit(); } catch(e) {} 'ok'`);
    if (isRunning(name)) stopApp(name);
  }
  const others = otherWindows();
  return [
    ...chrome,
    ...TIDY_APPS.filter(isRunning),
    ...stuck,
    ...(others === null ? ['(the tidy could not list open windows)'] : others.map((n) => `${n} windows`)),
    // named, so a window the tidy cannot close says what it is
    ...(finder === null ? ['(the tidy could not check Finder)'] : finder ? [`Finder windows: ${finder}`] : []),
  ];
}

/**
 * Dismisses what holds an app's windows, a sheet, a popover or a stand-alone dialog window (Finder's Go to Folder, which an
 * agent's Cmd+Shift+G leaves behind), with Esc to each such window
 * raised in turn: a held window does not close. Esc cancels what it holds (a Calendar event still being made is
 * dropped), so this tidies and never runs before a read; and never on an agent app (twice in a row opens Claude
 * Desktop's Rewind). Bounded; best effort.
 * @param {string[]} apps process names
 */
export function settleApps(apps) {
  jxaBounded(`const se=Application('System Events');
const dlg=(w)=>{ try { return w.subrole()==='AXDialog' || /^Go to /.test(w.name()||'') ? 1 : 0; } catch(e) { return 0; } };
const held=(p)=>p.windows().some((w)=>{ let n=dlg(w); try { n+=w.sheets().length; } catch(e) {} try { n+=w.popOvers().length; } catch(e) {} return n>0; });
for (const n of ${JSON.stringify(apps)}) { if (!se.processes.whose({name:n})().length) continue;
  const p=se.processes.byName(n);
  for (let i=0; i<3 && held(p); i++) for (const w of p.windows()) { let c=dlg(w); try { c+=w.sheets().length+w.popOvers().length; } catch(e) {}
    if (!c) continue; p.frontmost=true; try { w.actions.byName('AXRaise').perform(); } catch(e) {} delay(0.3);
    // Esc only to that app: another one in front (a person's sign-in) keeps its window (#1561)
    const f=se.processes.whose({frontmost:true})(); if (!f.length || f[0].name()!==n) continue;
    se.keyCode(53); delay(0.7); } }
'ok'`);
}

/** The apps whose windows stay between tasks: the agent apps (vendor and MoPilot), Finder (tidied above), and Chrome (cleaned only by admitted PID). */
const KEEP_WINDOWS = ['Claude', 'ChatGPT', 'Electron', 'MoPilot', 'Finder', 'Google Chrome'];

/** The apps with a window open besides those kept; null when System Events did not answer. */
function otherWindows() {
  const out = jxaBounded(`const se=Application('System Events');const keep=${JSON.stringify(KEEP_WINDOWS)};
se.processes.whose({backgroundOnly:false})().filter((p)=>{ try { return !keep.includes(p.name()) && p.windows().length>0; } catch(e) { return false; } }).map((p)=>p.name()).join('\\n')`);
  return out === null ? null : out.split('\n').filter(Boolean);
}

/** The folders of ~/Documents that belong to an app (a chat's working folder), not to a task: kept in place. */
const KEEP_DOCUMENTS = ['MoPilot', 'Codex'];

/**
 * Moves what a task saved or downloaded on the Desktop, in Documents or in Downloads to ~/mgb-leftovers/<folder>-<time>,
 * kept for reading a run: a later task would otherwise find another run's passport scan or declaration there. Hidden
 * files and the apps' Documents folders stay. Returns what could not be moved.
 */
function clearUserFolders() {
  const home = process.env.HOME ?? '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  /** @type {string[]} */
  const stuck = [];
  for (const folder of ['Desktop', 'Documents', 'Downloads']) {
    const from = path.join(home, folder);
    let names = /** @type {string[]} */ ([]);
    try {
      names = readdirSync(from).filter((n) => !n.startsWith('.') && !(folder === 'Documents' && KEEP_DOCUMENTS.includes(n)));
    } catch {
      continue;
    }
    if (!names.length) continue;
    const to = path.join(home, 'mgb-leftovers', `${folder.toLowerCase()}-${stamp}`);
    mkdirSync(to, { recursive: true });
    for (const n of names)
      try {
        renameSync(path.join(from, n), path.join(to, n));
      } catch {
        stuck.push(`~/${folder}/${n}`);
      }
  }
  return stuck;
}

/** TextEdit's and Preview's restored windows and autosaved drafts (their sandbox containers and the plain paths). */
const RESTORED_STATE = ['TextEdit', 'Preview'].flatMap((app) => {
  const box = `${process.env.HOME}/Library/Containers/com.apple.${app}/Data/Library`;
  return [
    `${box}/Saved Application State/com.apple.${app}.savedState`,
    `${box}/Autosave Information`,
    `${process.env.HOME}/Library/Saved Application State/com.apple.${app}.savedState`,
  ];
});

/** Runs a JXA script in the GUI session for at most 30 s; its result, or null when it failed or ran out of time. @param {string} script */
function jxaBounded(script) {
  try {
    return asUser('osascript', ['-l', 'JavaScript', '-'], script, 30);
  } catch {
    return null;
  }
}

/** Whether a process with exactly this name runs. @param {string} name */
function isRunning(name) {
  try {
    execFileSync('pgrep', ['-x', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Stops an app that did not quit: SIGTERM, then SIGKILL after 2 s. @param {string} name */
function stopApp(name) {
  for (const sig of ['TERM', 'KILL']) {
    try {
      execFileSync('pkill', [`-${sig}`, '-x', name], { stdio: 'ignore' });
    } catch {
      // gone
    }
    execFileSync('sleep', ['2']);
    if (!isRunning(name)) return;
  }
}

/**
 * Where an app's button with exactly this name is on screen (a sidebar row), as screen points; null when there is none.
 * Walks the Accessibility tree (slow on Electron apps, up to a minute).
 * @param {string} app the process name @param {string} name
 * @returns {{ x: number, y: number } | null}
 */
export function buttonAt(app, name) {
  enableAccessibility(app);
  const script = `function run(){const p=Application('System Events').processes.byName(${JSON.stringify(app)});const want=${JSON.stringify(name)};
function walk(el,d){if(d>30)return null;let kids=[];try{kids=el.uiElements();}catch(e){return null;}
for(const k of kids){let r='',n='';try{r=k.role();n=k.name()||'';}catch(e){}if(r==='AXButton'&&n===want){const p=k.position(),s=k.size();return (p[0]+Math.min(40,s[0]/2))+','+(p[1]+s[1]/2);}const f=walk(k,d+1);if(f)return f;}return null;}
for(const w of p.windows()){const f=walk(w,0);if(f)return f;}return '';}`;
  try {
    const out = asUser('osascript', ['-l', 'JavaScript', '-'], script, 120);
    const [x, y] = out.split(',').map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

/** Right-clicks at screen points (not screenshot space), with the app in front (see toFront). @param {number} x @param {number} y */
export function rightClickAt(x, y) {
  toFront();
  asUser(CLICLICK, [`rc:${Math.round(x)},${Math.round(y)}`]);
}

/** Refuse before Chrome launch/marking if a different or ambiguous browser instance is running. */
export function assertBenchChrome(profile) {
  const ps = execFileSync('ps', ['-axo', 'pid=,ucomm=,command='], { encoding: 'utf8' });
  const plan = chromeCleanupPlan(ps, profile);
  if (plan.blocked.length)
    throw new Error(`environment: ${plan.blocked.join('; ')}; leave it untouched and close it yourself before browser-use runs`);
  return plan.owned;
}

/** Keep owned Chrome in the precondition report if its windows or sheets could not be closed. */
function tidyBenchChrome(profile) {
  const pids = assertBenchChrome(profile);
  const result = jxaBounded(chromeCleanupScript(pids));
  if (result === null) return ['(the tidy could not check owned Chrome)'];
  try {
    const left = JSON.parse(result);
    return Array.isArray(left) && left.every((x) => typeof x === 'string') ? left : ['(invalid owned Chrome cleanup result)'];
  } catch {
    return ['(invalid owned Chrome cleanup result)'];
  }
}
