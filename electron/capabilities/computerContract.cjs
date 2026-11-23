// Computer-helper launch, framing, error, safety and request-classification contracts.
const path = require('node:path');
const { desktop } = require('../../shared/edition.json');
const { JsonReader } = require('../transport/jsonReader.cjs');

/** The helper's app folder and the name macOS shows for it (scripts/build-helper.mjs HELPER_NAME). */
const HELPER_NAME = 'MoPilot';
/**
 * The helper's hard floor, as Settings shows it (keep in step with native/helper/Sources/HelperCore/
 * DenyList.swift, which enforces it): apps it never controls, whatever main asks.
 */
const BUILT_IN_DENY = Object.freeze([
  { pattern: 'ai.mopilot.code.*', reason: 'MoPilot' },
  { pattern: 'com.apple.systempreferences', reason: 'System Settings' },
  { pattern: 'com.apple.SecurityAgent', reason: 'authentication prompt' },
  { pattern: 'com.apple.LocalAuthentication.UIAgent', reason: 'authentication prompt' },
  { pattern: 'com.apple.loginwindow', reason: 'login window' },
  // macOS's permission and consent prompts: a click there could grant (or revoke) a privacy permission
  { pattern: 'com.apple.tcc.AuthorizationPromptService', reason: 'permission prompt' },
  { pattern: 'com.apple.UserNotificationCenter', reason: 'permission prompt' },
  { pattern: 'com.apple.accessibility.universalAccessAuthWarn', reason: 'permission prompt' },
  { pattern: 'com.apple.screencaptureui', reason: 'permission prompt' },
  { pattern: 'com.apple.coreservices.uiagent', reason: 'permission prompt' },
  { pattern: 'com.apple.CoreLocationAgent', reason: 'permission prompt' },
  { pattern: 'com.apple.NetAuthAgent', reason: 'authentication prompt' },
  { pattern: 'com.apple.keychainaccess', reason: 'Keychain Access' },
  { pattern: 'com.apple.Passwords.*', reason: 'Passwords' },
  { pattern: 'com.1password.*', reason: 'password manager' },
  { pattern: 'com.agilebits.*', reason: 'password manager' },
  { pattern: 'com.bitwarden.desktop', reason: 'password manager' },
  { pattern: 'com.lastpass.LastPass', reason: 'password manager' },
  { pattern: 'in.sinew.Enpass-Desktop', reason: 'password manager' },
  { pattern: 'org.keepassxc.keepassxc', reason: 'password manager' },
]);
const HELPER_BUNDLE_ID = `${desktop.appId}.computer-use`;

/**
 * The deny list main sends the helper: the floor first, then the user's. A helper built before a floor rule was added
 * (a stale dev build) still refuses that app; one that has it ignores the repeat.
 */
function withFloor(bundleIds) {
  const seen = new Set();
  return [...BUILT_IN_DENY.map((d) => d.pattern), ...(bundleIds ?? [])].filter((id) => {
    const k = String(id).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Where the helper app lives: Contents/Helpers in a packaged app, native/helper/build in a checkout. */
function helperAppPath({ packaged = false, resourcesPath = process.resourcesPath, repoRoot = path.join(__dirname, '../..') } = {}) {
  return packaged
    ? path.join(resourcesPath, '..', 'Helpers', `${HELPER_NAME}.app`)
    : path.join(repoRoot, 'native/helper/build', `${HELPER_NAME}.app`);
}

/**
 * `open` arguments: a new instance (-n) in the background (-g), so LaunchServices makes the helper its
 * own responsible process. Only the config path goes in argv; the token stays in the 0600 file.
 */
function launchArgs(appPath, configPath) {
  return ['-n', '-g', '-a', appPath, '--args', '--launch', configPath];
}

/**
 * Opens the helper app with its launch config (`open -n -g`) and resolves when `open` has handed it over.
 * @param {Function} spawn @param {string} appPath @param {string} configPath @returns {Promise<void>}
 */
function openHelper(spawn, appPath, configPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', launchArgs(appPath, configPath), { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open failed (${code}): ${err.trim()}`))));
  });
}

/**
 * Splits a byte stream into JSON messages, one per line; bad lines go to `onError`.
 * @param {(message: any) => void} onMessage
 * @param {(error: unknown) => void} [onError]
 * @param {{ stream?: any, onFailure?: (error: Error) => void }} [options]
 */
function lineDecoder(
  onMessage,
  onError = () => {
    /* bad lines are dropped when no one listens */
  },
  { stream, onFailure = onError } = {},
) {
  const reader = new JsonReader({
    stream,
    onValue: (message) => {
      try {
        onMessage(message);
      } catch (e) {
        onError(e);
      }
    },
    onInvalid: onError,
    onError: onFailure,
  });
  return Object.assign((chunk) => reader.push(chunk), { reader });
}

/**
 * Follows one helper socket generation; EOF drains replies and a replaced socket cannot publish. A streaming dictation's
 * notifications (speech.stream.*) go out as the owner's 'speech' event, for main's speech streams.
 */
function attachHelperSocket(owner, sock, onMessage, onClosed) {
  owner.jsonReader?.close();
  owner.socket = sock;
  const decode = lineDecoder(
    (msg) => {
      if (owner.socket !== sock) return;
      if (msg.id == null && String(msg.method).startsWith('speech.stream.')) owner.emit('speech', msg.method, msg.params || {});
      else onMessage(msg);
    },
    undefined,
    { stream: sock, onFailure: () => sock.destroy() },
  );
  owner.jsonReader = decode.reader;
  sock.on('data', decode);
  sock.on('error', () => {
    /* the close handler below deals with a lost socket */
  });
  sock.on('close', () => {
    decode.reader.finishInput(() => {
      if (owner.socket !== sock) return;
      owner.socket = null;
      owner.jsonReader = null;
      for (const p of owner.pending.values()) p.reject(new HelperError('computer-use helper exited', null, 'helper_exited'));
      owner.pending.clear();
      onClosed();
      owner.emit('exit');
    });
  });
}

class HelperError extends Error {
  constructor(message, code, reason) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

/**
 * What fixes a missing or outdated helper, for the user and the model: a packaged app ships the helper,
 * so only reinstalling or updating MoPilot helps there; a checkout builds it. Developer advice never
 * reaches a packaged app's users.
 * @param {boolean} packaged
 */
function helperFix(packaged) {
  return packaged ? 'update or reinstall MoPilot' : 'rebuild it (node scripts/build-helper.mjs)';
}

/**
 * The tool error for a helper too old for a request (`method_not_found`), with the fix the helper that
 * answered carries (`e.fix`, set by ComputerHelper); `what` narrows the sentence ("for background control").
 * @param {{ fix?: string } | null | undefined} e
 * @param {string} [what]
 */
function outdatedHelperText(e, what = '') {
  return `The computer-use helper is out of date${what ? ` ${what}` : ''}; ${e?.fix || helperFix(true)} and try again`;
}

/**
 * Requests that only read. When the helper exits while one runs, it goes once more to the relaunched
 * helper; anything else (input, menus, launching apps) may already have happened and is never replayed.
 */
const READ_ONLY = new Set([
  'permissions.status',
  'speech.status',
  // MoMo's Calendar and Reminders sources (EventKit), reads only
  'eventkit.status',
  'calendar.calendars',
  'calendar.events',
  'reminders.lists',
  'reminders.items',
  'screenshot',
  'target.info',
  'ax.snapshot',
  'ocr.elements',
  'input.idle',
  'input.escape',
  'input.cursor',
  'apps.list',
  'apps.resolve',
  'activity.sample',
  'displays.list',
  'text.focused',
  'app.windows',
  'app.screenshot',
  'app.zoom',
  // opens a background app's menu and cancels it at once, so the app revalidates it: nothing to duplicate
  'app.menuRefresh',
]);
/**
 * Requests about the running helper's own state (undoing it, or reading who sent the last Escape): a helper that
 * isn't running has none, so none is launched for them.
 */
const NO_LAUNCH = new Set([
  'control.release',
  'input.release',
  'glow.stop',
  'pasteboard.restore',
  'app.cancel',
  'turn.revoke',
  'input.escape',
  'record.stop',
]);
/**
 * Requests that give the user's Mac back (let go of the lock and held input, show hidden apps, put the clipboard
 * back, stop a batch), and the read of who sent the last Escape (Esc-to-stop asks outside any call): they run for a
 * stopped call too. Every other request is refused once its call may no
 * longer act (./contract/actionGuard.cjs), so nothing happens on the Mac for a turn after Stop, Esc or its end.
 */
const GIVES_BACK = new Set([...NO_LAUNCH, 'apps.restore']);

module.exports = {
  helperFix,
  outdatedHelperText,
  GIVES_BACK,
  READ_ONLY,
  NO_LAUNCH,
  BUILT_IN_DENY,
  withFloor,
  HELPER_NAME,
  HELPER_BUNDLE_ID,
  helperAppPath,
  launchArgs,
  openHelper,
  lineDecoder,
  attachHelperSocket,
  HelperError,
};
