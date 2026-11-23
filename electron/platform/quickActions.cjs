// macOS Quick Actions (Services menu): three Automator workflows in ~/Library/Services that open a new MoPilot chat through a mopilot:// link (shared/deepLink.mjs parseNewChatLink). Written only when the user turns them on in Settings, removed when they turn them off; only files carrying this module's marker are ever replaced or deleted.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const childProcess = require('node:child_process');
const { APP_SCHEME, LINK_FILES_MAX, LINK_TEXT_MAX } = require('../../shared/deepLink.mjs');
const { desktop } = require('../../shared/edition.json');

const PREFIX = `${desktop.name} - `;
/** Info.plist key whose value is the action's id: what makes a workflow ours. */
const MARKER = 'MoPilotQuickAction';
const FINDER_ID = 'com.apple.finder';
const FINDER_PATH = '/System/Library/CoreServices/Finder.app';

/** The actions, in the order the Services menu shows them. `input` is what the workflow receives. */
const ACTIONS = [
  { id: 'ask', title: `Ask ${desktop.name}`, input: 'text', finderOnly: false },
  { id: 'chat-here', title: `New ${desktop.name} Chat Here`, input: 'folder', finderOnly: true },
  { id: 'send', title: `Send to ${desktop.name}`, input: 'files', finderOnly: false },
];

const INPUT = {
  text: { type: 'text', method: 0, presentation: 11, send: ['NSSendTypes', 'public.utf8-plain-text'] },
  folder: { type: 'fileSystemObject.folder', method: 1, presentation: 15, send: ['NSSendFileTypes', 'public.folder'] },
  files: { type: 'fileSystemObject', method: 1, presentation: 15, send: ['NSSendFileTypes', 'public.item'] },
};

/** A shell word for `s`: single-quoted, so nothing in an install path is expanded. */
const shellWord = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The workflow's shell script: percent-encodes what it was given and opens the new-chat link in this app. */
function scriptFor(action, appPath) {
  const enc =
    'enc() { V="$1" /usr/bin/osascript -l JavaScript -e \'ObjC["import"]("stdlib"); function run(){return encodeURIComponent($.getenv("V"))}\'; }';
  // one osascript call encodes every path (one per line: the link parser refuses paths with control characters)
  const encAll =
    'encAll() { /usr/bin/osascript -l JavaScript -e \'function run(argv){return argv.map(encodeURIComponent).join("\\n")}\' "$@"; }';
  const open = (query) => `/usr/bin/open -a ${shellWord(appPath)} "${APP_SCHEME}://chat/new?source=services${query}"`;
  const body = {
    text: `t=$(/usr/bin/head -c ${LINK_TEXT_MAX} | /usr/bin/iconv -c -f UTF-8 -t UTF-8); ${open('&q=$(enc "$t")')}`,
    folder: open('&folder=$(enc "$1")'),
    files: `q=""; for e in $(encAll "\${@:1:${LINK_FILES_MAX}}"); do q="$q&file=$e"; done; ${open('$q')}`,
  }[action.input];
  return `${enc}\n${encAll}\n${body}\n`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A property list (Apple's XML form) of plain data: objects, arrays, strings, integers and booleans. */
function plist(value) {
  const node = (v, pad) => {
    if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>\n`;
    if (typeof v === 'boolean') return `${pad}<${v}/>\n`;
    if (typeof v === 'number') return `${pad}<integer>${v}</integer>\n`;
    if (Array.isArray(v))
      return v.length ? `${pad}<array>\n${v.map((x) => node(x, `${pad}\t`)).join('')}${pad}</array>\n` : `${pad}<array/>\n`;
    const entries = Object.entries(v);
    if (!entries.length) return `${pad}<dict/>\n`;
    return `${pad}<dict>\n${entries.map(([k, x]) => `${pad}\t<key>${esc(k)}</key>\n${node(x, `${pad}\t`)}`).join('')}${pad}</dict>\n`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${node(value, '')}</plist>\n`;
}

/** Stable UUIDs per action, so reinstalling the same workflow writes the same bytes. */
function uuids(id) {
  const h = createHash('sha256').update(`${APP_SCHEME}-quick-action:${id}`).digest('hex').toUpperCase();
  const at = (n) =>
    `${h.slice(n, n + 8)}-${h.slice(n + 8, n + 12)}-${h.slice(n + 12, n + 16)}-${h.slice(n + 16, n + 20)}-${h.slice(n + 20, n + 32)}`;
  return { action: at(0), input: at(8), output: at(16) };
}

/** What a workflow bundle holds for `action`: Contents/document.wflow and Contents/Info.plist, as text. */
function workflowFiles(action, appPath) {
  const input = INPUT[action.input];
  const typeId = `com.apple.Automator.${input.type}`;
  const id = uuids(action.id);
  const wflow = plist({
    AMApplicationBuild: '534',
    AMApplicationVersion: '2.10',
    AMDocumentVersion: '2',
    actions: [
      {
        action: {
          AMAccepts: { Container: 'List', Optional: true, Types: ['com.apple.cocoa.string'] },
          AMActionVersion: '2.0.3',
          AMApplication: ['Automator'],
          AMProvides: { Container: 'List', Types: ['com.apple.cocoa.string'] },
          ActionBundlePath: '/System/Library/Automator/Run Shell Script.action',
          ActionName: 'Run Shell Script',
          ActionParameters: {
            COMMAND_STRING: scriptFor(action, appPath),
            CheckedForUserDefaultShell: true,
            inputMethod: input.method,
            shell: '/bin/zsh',
            source: '',
          },
          BundleIdentifier: 'com.apple.RunShellScript',
          CFBundleVersion: '2.0.3',
          CanShowSelectedItemsWhenRun: false,
          CanShowWhenRun: true,
          Category: ['AMCategoryUtilities'],
          'Class Name': 'RunShellScriptAction',
          InputUUID: id.input,
          OutputUUID: id.output,
          UUID: id.action,
          UnlocalizedApplications: ['Automator'],
          isViewVisible: 1,
        },
      },
    ],
    connectors: {},
    workflowMetaData: {
      ...(action.finderOnly
        ? {
            applicationBundleID: FINDER_ID,
            applicationBundleIDsByPath: { [FINDER_PATH]: FINDER_ID },
            applicationPath: FINDER_PATH,
            applicationPaths: [FINDER_PATH],
          }
        : { applicationBundleIDsByPath: {}, applicationPaths: [] }),
      inputTypeIdentifier: typeId,
      outputTypeIdentifier: 'com.apple.Automator.nothing',
      presentationMode: input.presentation,
      processesInput: false,
      ...(action.finderOnly ? { serviceApplicationBundleID: FINDER_ID, serviceApplicationPath: FINDER_PATH } : {}),
      serviceInputTypeIdentifier: typeId,
      serviceOutputTypeIdentifier: 'com.apple.Automator.nothing',
      serviceProcessesInput: false,
      systemImageName: 'NSActionTemplate',
      useAutomaticInputType: false,
      workflowTypeIdentifier: 'com.apple.Automator.servicesMenu',
    },
  });
  const info = plist({
    [MARKER]: action.id,
    NSServices: [
      {
        NSBackgroundColorName: 'background',
        NSIconName: 'NSActionTemplate',
        NSMenuItem: { default: action.title },
        NSMessage: 'runWorkflowAsService',
        ...(action.finderOnly ? { NSRequiredContext: { NSApplicationIdentifier: FINDER_ID } } : {}),
        [input.send[0]]: [input.send[1]],
      },
    ],
  });
  return { wflow, info };
}

/** The .app that contains `exe` (the running executable), or null outside a bundle. */
function bundleOf(exe) {
  const m = /^(.*?\.app)(\/|$)/.exec(exe || '');
  return m ? m[1] : null;
}

/**
 * @param {object} [o]
 * @param {string} [o.home]
 * @param {string | null} [o.appPath] the installed .app the workflows open; null when this isn't a packaged macOS app
 * @param {NodeJS.Platform} [o.platform]
 * @param {typeof childProcess.execFile} [o.execFile] runs the Services menu refresh (pbs -update); tests pass their own
 */
function createQuickActions(o = {}) {
  const home = o.home ?? os.homedir();
  const platform = o.platform ?? process.platform;
  const appPath = o.appPath ?? null;
  // a refresh that fails changes nothing the files don't already say: the menu catches up at the next login
  const run = (file, args) =>
    new Promise((resolve) => (o.execFile ?? childProcess.execFile)(file, args, { timeout: 10_000 }, () => resolve(undefined)));
  const dirOf = (a) => path.join(home, 'Library', 'Services', `${PREFIX}${a.id}.workflow`);
  const read = (a, name) => {
    try {
      return fs.readFileSync(path.join(dirOf(a), 'Contents', name), 'utf8');
    } catch {
      return null;
    }
  };
  /** Whether this action's folder is one this module wrote (never a workflow the user made under the same name). */
  const ours = (a) => read(a, 'Info.plist')?.includes(`<key>${MARKER}</key>`) === true;
  const refresh = () => run('/System/Library/CoreServices/pbs', ['-update']);

  return {
    /** `unavailable`: not macOS, or not running from an installed .app; `stale`: installed for another copy of the app or an older version of the actions. */
    status() {
      if (platform !== 'darwin' || !appPath) return { state: 'unavailable', installed: 0, total: ACTIONS.length };
      const present = ACTIONS.filter((a) => ours(a));
      const stale = present.some((a) => {
        const want = workflowFiles(a, appPath);
        return read(a, 'document.wflow') !== want.wflow || read(a, 'Info.plist') !== want.info;
      });
      const state = !present.length ? 'off' : present.length < ACTIONS.length || stale ? 'stale' : 'on';
      return { state, installed: present.length, total: ACTIONS.length };
    },
    /** Writes all three workflows (replacing ours, never a user's own with the same name). Throws when one can't be written. */
    async install() {
      if (platform !== 'darwin' || !appPath) throw new Error('Quick Actions need the installed MoPilot app on a Mac');
      for (const a of ACTIONS) {
        if (fs.existsSync(dirOf(a)) && !ours(a)) throw new Error(`${path.basename(dirOf(a))} is already in Services and isn't MoPilot's`);
      }
      try {
        for (const a of ACTIONS) {
          const files = workflowFiles(a, appPath);
          const dir = path.join(dirOf(a), 'Contents');
          fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
          fs.writeFileSync(path.join(dir, 'document.wflow'), files.wflow, { mode: 0o644 });
          fs.writeFileSync(path.join(dir, 'Info.plist'), files.info, { mode: 0o644 });
        }
      } catch (error) {
        // all or none: a half-written set would read as on in Settings and could not be turned on again
        // (each folder was absent or ours before the writes began, so each is ours to remove)
        for (const a of ACTIONS) fs.rmSync(dirOf(a), { recursive: true, force: true });
        throw error;
      }
      await refresh();
      return this.status();
    },
    /** Removes the workflows this module wrote; anything else in Services stays. */
    async uninstall() {
      if (platform !== 'darwin') throw new Error('Quick Actions are a Mac feature');
      for (const a of ACTIONS) if (ours(a)) fs.rmSync(dirOf(a), { recursive: true, force: true });
      await refresh();
      return this.status();
    },
  };
}

module.exports = { createQuickActions, workflowFiles, scriptFor, plist, bundleOf, ACTIONS, MARKER, PREFIX };
