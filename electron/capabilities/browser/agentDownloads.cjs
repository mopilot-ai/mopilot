// A download in a tab an agent drives, for every harness: saved into the chat's downloads folder (never a save sheet nobody
// would answer), and reported with the chat's next result: where the file landed, or that it was stopped or failed and
// no file was saved. Codex's Browser plugin hears the same steps through the host's download listeners. A download in
// the user's Chrome (MoPilot's extension reports it, chrome-extension/src/downloads.mjs) is saved where Chrome's
// own settings say and reported the same way (reportChromeDownload).
const crypto = require('node:crypto');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');
const { safeFileName } = require('./hostUtil.cjs');
const { reserveDownloadPath } = require('./downloadName.cjs');
const { ownTable } = require('../../../shared/ownTable.mjs');

/** What the agent's next result says when a download ends, by Electron's final state. */
function downloadOutcome(/** @type {string} */ state, /** @type {string} */ name, /** @type {string} */ file) {
  if (state === 'completed') return `download_completed ${name} -> ${file}`;
  if (state === 'cancelled') return `download_cancelled ${name}: stopped before it finished, so no file was saved`;
  return `download_failed ${name}: the download failed, so no file was saved`;
}

/** A line saying how an agent's download ended: it outlives the turn, since a file can finish after the agent's last call. */
const isDownloadOutcome = (/** @type {string} */ line) => /^download_(completed|cancelled|failed) /.test(line);

/** The status Codex's Browser plugin expects for a download that ended, by Electron's final state. */
const PLUGIN_STATUS = ownTable({ completed: 'complete', cancelled: 'canceled' });

/**
 * Saves `item` for the agent driving `tab` into `dir`, its chat's downloads folder, and reports it. Returns the path, or
 * null when the folder can't be made (the user's download settings then apply).
 * @param {InstanceType<typeof import('./host.cjs').BrowserTabs>} host
 * @param {import('./host.cjs').Tab} tab
 * @param {Electron.DownloadItem} item
 * @param {string} dir
 */
function saveAgentDownload(host, tab, item, dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const file = reserveDownloadPath(dir, safeFileName(item.getFilename()), item);
  const entry = { name: path.basename(file), path: file, state: 'progressing' };
  tab.downloads.push(entry);
  if (tab.downloads.length > 20) tab.downloads.shift();
  host.change(tab.chatId, `download_started ${entry.name} in ${tab.id}`);
  const id = crypto.randomUUID();
  const url = String(item.getURL?.() ?? '');
  const tell = (/** @type {string} */ status) => tellListeners(host, { tab, id, url, filename: file, status });
  tell('started');
  item.on?.('updated', () => tell('in_progress'));
  item.once('done', (_e, state) => {
    entry.state = state;
    // a chat deleted meanwhile (forget) has nobody to tell
    if (host.chats.has(tab.chatId)) host.change(tab.chatId, downloadOutcome(state, entry.name, file));
    tell(PLUGIN_STATUS[state] ?? 'failed');
  });
  return file;
}

/** Tells the host's download listeners (Codex's Browser plugin) a step of a download. */
function tellListeners(host, /** @type {{ tab: any, id: string, url: string, filename: string, status: string }} */ step) {
  for (const fn of host.downloadListeners) {
    try {
      fn(step);
    } catch (error) {
      // one listener error must not stop the download or the others
      noteIgnored('tell a listener about a browser download', error);
    }
  }
}

/** Downloads in a Chrome tab seen so far, by the extension's download id: their entries in tab.downloads. */
const chromeEntries = new WeakMap();

/**
 * A step of a download the agent started in a tab of the user's Chrome, as MoPilot's extension reports it:
 * { id, url, filename, state: 'in_progress' | 'complete' | 'interrupted', error }. Reported once when it starts and
 * once when it ends, like saveAgentDownload's.
 * @param {InstanceType<typeof import('./host.cjs').BrowserTabs>} host
 * @param {import('./host.cjs').Tab} tab
 * @param {{ id: number, url?: string, filename?: string, state?: string, error?: string | null }} d
 */
function reportChromeDownload(host, tab, d) {
  let seen = chromeEntries.get(tab);
  if (!seen) chromeEntries.set(tab, (seen = new Map()));
  const file = String(d.filename || '');
  const name = file
    ? path.basename(file)
    : safeFileName(
        String(d.url || '')
          .split(/[?#]/)[0]
          .split('/')
          .pop() || 'download',
      );
  let entry = seen.get(d.id);
  const id = `chrome-${d.id}`;
  const step = (/** @type {string} */ status) => tellListeners(host, { tab, id, url: String(d.url || ''), filename: file, status });
  if (!entry) {
    entry = { name, path: file, state: 'progressing' };
    seen.set(d.id, entry);
    tab.downloads.push(entry);
    if (tab.downloads.length > 20) tab.downloads.shift();
    host.change(tab.chatId, `download_started ${name} in ${tab.id}`);
    step('started');
  }
  Object.assign(entry, { name, path: file || entry.path });
  if (d.state !== 'complete' && d.state !== 'interrupted') return;
  // Chrome's reasons: the user (or a page) stopped it, or it failed
  const state = d.state === 'complete' ? 'completed' : d.error === 'USER_CANCELED' ? 'cancelled' : 'interrupted';
  entry.state = state;
  seen.delete(d.id);
  if (host.chats.has(tab.chatId)) host.change(tab.chatId, downloadOutcome(state, entry.name, entry.path));
  step(PLUGIN_STATUS[state] ?? 'failed');
}

module.exports = { saveAgentDownload, reportChromeDownload, downloadOutcome, isDownloadOutcome };
