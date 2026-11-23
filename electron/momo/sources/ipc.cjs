// IPC for Settings › MoMo › Sources (#2139 P2, src/components/momo/SourcesSection.tsx): every source with its state, connecting (asking macOS first for Calendar and Reminders), disconnecting (which deletes MoMo's copies), the access level, the Files folders, the calendars' and lists' names for the row, and macOS's privacy pane when access was refused; every change goes to the windows as momoSources:changed (no data in it). Every handler refuses while MoMo is not allowed. The cloud accounts' and the coding-side MCP servers' rows on the same page have their own channels (connectors/ipc.cjs, mcp/ipc.cjs), registered here with these.
const { messageOf, noteIgnored } = require('../../ignored.cjs');
const { SourceError, SOURCE_IDS } = require('./hub.cjs');
const { PRIVACY_PANES, SWITCH_GRANTS } = require('./eventKit.cjs');
const { GrantWatch } = require('../../../shared/grantWatch.cjs');
const { registerConnectorsIpc } = require('../connectors/ipc.cjs');
const { registerMcpIpc } = require('../mcp/ipc.cjs');

const CHANNELS = Object.freeze([
  'momoSources:list',
  'momoSources:detail',
  'momoSources:connect',
  'momoSources:recheck',
  'momoSources:cancelConnect',
  'momoSources:disconnect',
  'momoSources:setLevel',
  'momoSources:addFolder',
  'momoSources:removeFolder',
  'momoSources:openPrivacy',
  'momoSources:writes',
  'momoSources:undoWrite',
]);
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });

/**
 * Registers the handlers; returns a function that removes them again.
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ sources: ReturnType<typeof import('./index.cjs').createMomoSources>, writer: ReturnType<typeof import('./write.cjs').createWriter>, allowed: () => boolean,
 *           pickFolder: (event: Electron.IpcMainInvokeEvent) => Promise<string | null>,
 *           broadcast?: ((channel: string) => void) | null, openExternal?: ((url: string) => unknown) | null,
 *           watchOptions?: object }} o
 *   pickFolder: main's folder dialog over the window that sent the call (the folder the user picked, null when they
 *   cancelled); it throws when the sender is not one of the app's windows. broadcast: to every window; openExternal:
 *   Electron's shell.openExternal
 */
function registerSourcesIpc(ipcMain, { sources, writer, allowed, pickFolder, broadcast = null, openExternal = null, watchOptions = {} }) {
  const { hub } = sources;
  const offConnectors = registerConnectorsIpc(ipcMain, { hub: sources.connectorHub, allowed, broadcast });
  const offMcp = registerMcpIpc(ipcMain, { proxy: sources.mcpProxy, allowed, broadcast });
  const changed = () => {
    if (allowed() === true) broadcast?.('momoSources:changed');
  };
  hub.on('changed', changed);
  // what MoMo wrote changed (a write kept, one undone): the Memory tab's list is read again
  const writesChanged = () => {
    if (allowed() === true) broadcast?.('momoMemory:changed');
  };
  sources.writeLedger.on('changed', writesChanged);
  // a grant macOS will not ask for again: the pane is opened and the connect finishes when the user turns the switch on
  // a helper keeps the answer it first gave (EventKit's store caches it), so a switch turned on since is only seen by a helper
  // launched after it: an idle one is quit as the source connects, and the next read starts a fresh one. A working one (computer
  // use) is left to finish.
  const connectGranted = (/** @type {string} */ id, /** @type {number} */ epoch) => {
    sources.eventKit.release();
    return hub.connect(id, { epoch });
  };
  const watch = new GrantWatch({
    isGranted: async (id) => (await sources.eventKit.status({ fresh: true }))[/** @type {'calendar'|'reminders'} */ (id)] === 'granted',
    onGranted: connectGranted,
    onChange: changed,
    onError: noteIgnored,
    ...watchOptions,
  });
  /**
   * A handler that answers NOT_ALLOWED while MoMo is not allowed, and a failure
   * as `{ ok: false, error, reason? }`. The handler gets the call's event, then its arguments.
   */
  const on = (/** @type {string} */ channel, /** @type {(...args: any[]) => any} */ fn) =>
    ipcMain.handle(channel, async (e, ...args) => {
      if (allowed() !== true) return NOT_ALLOWED;
      try {
        return { ok: true, ...(await fn(e, ...args)) };
      } catch (error) {
        return { ok: false, error: messageOf(error), ...(error instanceof SourceError && { reason: error.code }) };
      }
    });
  const source = (/** @type {unknown} */ id) => {
    if (typeof id !== 'string' || !SOURCE_IDS.includes(id)) throw new SourceError(`No source named ${String(id)}`, 'unknown');
    return sources.byId[/** @type {'calendar'|'reminders'|'files'} */ (id)];
  };
  on('momoSources:list', () => ({ sources: hub.list(), available: hub.available(), waiting: watch.names() }));
  // the names on a connected source's row; a source that isn't connected shows none, and asks macOS nothing. This is also where a
  // connected source whose grant macOS has taken back (reset, or another build asked) shows: the names are refused, and the list
  // says it needs the grant; names that come back say it has it.
  on('momoSources:detail', async (_e, id) => {
    const s = source(id);
    if (!hub.get(s.id)) return { items: [] };
    try {
      const items = await s.detail();
      hub.markGranted(s.id);
      return { items };
    } catch (error) {
      if (error instanceof SourceError && error.code === 'not_granted') hub.markUngranted(s.id);
      throw error;
    }
  });
  /**
   * Opens the privacy pane for a source and waits for the switch. The helper is quit first, so System Settings has no running
   * app to ask to Quit & Reopen when the switch goes on; one that is working is not cut off: the row says so and the user
   * turns it on again when it is done.
   */
  const openPaneAndWatch = async (/** @type {{ id: string }} */ s, /** @type {number} */ epoch) => {
    const pane = PRIVACY_PANES[/** @type {keyof typeof PRIVACY_PANES} */ (s.id)];
    if (!pane || !openExternal) throw new SourceError('There is no macOS setting for this source', 'unavailable');
    if (sources.eventKit.release() === 'busy') throw new SourceError('Computer use is working. Try again when it is done.', 'busy');
    await openExternal(pane);
    watch.start(s.id, epoch);
  };
  // a refusal macOS repeats without asking (denied before) opens the exact pane and waits for the switch; one the user
  // just gave at macOS's own prompt (asked) is left as their answer
  on('momoSources:connect', async (_e, id) => {
    const s = source(id);
    const epoch = hub.epoch(s.id);
    const r =
      /** @type {{ connected: boolean, grant: string, asked?: boolean, noPrompt?: boolean, reset?: boolean, requestError?: string }} */ (
        await s.connect()
      );
    // macOS answered without its prompt: what the helper said about the request goes where "Copy diagnostics" finds it
    if (r.noPrompt)
      noteIgnored(
        `macOS showed no ${s.id} prompt (the helper's grant record was ${r.reset ? 'cleared once' : 'not cleared'})`,
        new Error(r.requestError ?? 'the request returned without a prompt'),
      );
    if (
      r.connected ||
      r.asked ||
      !SWITCH_GRANTS.has(r.grant) ||
      !PRIVACY_PANES[/** @type {keyof typeof PRIVACY_PANES} */ (s.id)] ||
      !openExternal
    )
      return r;
    await openPaneAndWatch(s, epoch);
    return { ...r, waiting: true };
  });
  // the window came back to the front: read the grant now and connect when the switch went on, so the row turns Connected at
  // once and also after a wait that ended (a helper that is running keeps its first answer, so a helper launched for the read).
  // A source that is connected but refused by macOS is read the same way: the switch going on clears what the list says.
  on('momoSources:recheck', async (_e, id) => {
    const s = source(id);
    if (!PRIVACY_PANES[/** @type {keyof typeof PRIVACY_PANES} */ (s.id)]) return { connected: hub.get(s.id) !== null };
    if (hub.ready(s.id)) return { connected: true };
    const epoch = hub.epoch(s.id);
    const status = await sources.eventKit.status({ fresh: true });
    if (status[/** @type {'calendar' | 'reminders'} */ (s.id)] !== 'granted') return { connected: false };
    const connected = connectGranted(s.id, epoch);
    if (connected) watch.cancel(s.id);
    return { connected };
  });
  on('momoSources:cancelConnect', (_e, id) => ({ cancelled: watch.cancel(source(id).id) }));
  // an account whose invite was revoked can still remove what MoMo kept
  on('momoSources:disconnect', (_e, id) => (hub.disconnect(source(id).id), {}));
  on('momoSources:setLevel', (_e, id, level) => (hub.setLevel(source(id).id, level), {}));
  // the folder comes from main's own dialog, never from the renderer
  on('momoSources:addFolder', async (/** @type {Electron.IpcMainInvokeEvent} */ e) => {
    const picked = await pickFolder(e);
    if (picked === null) return { cancelled: true, folders: await sources.files.detail() };
    return { cancelled: false, folders: sources.files.addFolder(picked) };
  });
  on('momoSources:removeFolder', (_e, p) => ({ folders: sources.files.removeFolder(p) }));
  // the row's Open Settings: whatever macOS last answered (even none, when it never showed its prompt), the pane opens and the
  // connect finishes by itself when the switch goes on
  on('momoSources:openPrivacy', async (_e, id) => {
    const s = source(id);
    await openPaneAndWatch(s, hub.epoch(s.id));
    return {};
  });
  // what MoMo wrote to Calendar and Reminders in the last 30 days, and the user's own Undo of one (audited, no card: it is their act)
  on('momoSources:writes', () => ({ writes: writer.written() }));
  on('momoSources:undoWrite', async (_e, id) => (await writer.undoByUser(id), {}));
  return () => {
    for (const name of watch.names()) watch.cancel(name);
    hub.off('changed', changed);
    sources.writeLedger.off('changed', writesChanged);
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
    offConnectors();
    offMcp();
  };
}

module.exports = { registerSourcesIpc, CHANNELS, NOT_ALLOWED, PRIVACY_PANES };
