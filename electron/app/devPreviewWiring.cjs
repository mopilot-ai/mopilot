// Dev-preview composition: preview tools, child-process browser shim, approval wiring and shutdown cleanup.
const path = require('node:path');
const { DevPreviews, registerPreviewTools, paneOpener } = require('../capabilities/browser/devPreview.cjs');
const { BrowserShim } = require('../capabilities/browser/browserShim.cjs');
const { inAppBrowserEnabled } = require('../capabilities/browser/hostTools.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { addHook } = require('../session/hookChain.cjs');

/**
 * @param {Pick<import('../main.cjs').BrowserToolsDeps, 'app' | 'shellEnv' | 'isFlagEnabled' | 'chatProject' | 'live'> & {
 *   browser: { readonly tabs: InstanceType<typeof import('../capabilities/browser/host.cjs').BrowserTabs>,
 *              readonly grants: InstanceType<typeof import('../capabilities/browser/origins.cjs').OriginGrants> }
 * }} o browser getters retain current tabs/grants across browser-tool registration.
 */
function createDevPreviewWiring({ app, shellEnv, isFlagEnabled, chatProject, live, browser }) {
  /** Dev servers chats started (electron/capabilities/browser/devPreview.cjs), and the $BROWSER shim (browserShim.cjs). */
  /** @type {InstanceType<typeof DevPreviews> | null} */
  let devPreviews = null;
  /** @type {InstanceType<typeof BrowserShim> | null} */
  let browserShim = null;
  const deletionOwners = new WeakSet();
  /**
   * Dev-server previews (IAB-02): the browser_preview_* tools for every harness, the servers they start,
   * and the $BROWSER shim that brings URLs CLIs open into the chat's pane. Needs browser.tabs and browser.grants.
   */
  function registerDevPreviews(dir) {
    const previewsOn = () =>
      isFlagEnabled('shared.browser.devPreview') ? inAppBrowserEnabled(isFlagEnabled) : 'Dev-server previews are turned off.';
    const openInPane = paneOpener({ tabs: browser.tabs, grants: browser.grants });
    const shim = (browserShim ??= new BrowserShim({
      dir: path.join(dir, 'bin'),
      open: async (chatId, url) => previewsOn() === true && !!(await openInPane(chatId, url, { ask: true })),
      // a shared harness process (Codex's app-server, an ACP agent): the chat running a turn in that folder
      running: () =>
        Promise.all(
          live.sessions
            .all()
            .filter((id) => ['running', 'awaitingUser'].includes(live.sessions.get(id).turn))
            .map(async (chatId) => ({ chatId, cwd: await chatProject(chatId) })),
        ),
    }));
    shim
      .listen()
      .then(() => shellEnv.setExtraEnv((env) => (previewsOn() === true ? shim.env(null, env) : {})))
      .catch((e) => console.error('browser shim', e));
    devPreviews ??= new DevPreviews({
      stateFile: path.join(dir, 'preview-servers.json'),
      canRestore: async (record) => {
        const allowed = () => {
          const chat = live.chats.record(record.chatId);
          return (
            !!chat &&
            typeof chat.meta.archived !== 'number' &&
            !live.chatDeletion?.isDeleted(record.chatId) &&
            previewsOn() === true &&
            (live.hostOwnership?.get(record.chatId).hostId ?? 'local') === 'local' &&
            browser.grants.anchor({ chatId: record.chatId, segmentId: '' }) !== 'readOnly'
          );
        };
        if (!allowed()) return false;
        const project = await chatProject(record.chatId);
        return allowed() && project === record.launch.project;
      },
      env: () => shellEnv.childEnv(),
      // the server's own `open` (vite --open) lands in the chat that started it
      chatEnv: (chatId) => (previewsOn() === true ? shim.env(chatId) : {}),
      onReady: (s) => {
        if (!s.autoOpen) return;
        openInPane(s.chatId, s.url, { tabId: s.tabId })
          .then((tab) => tab && (s.tabId = tab.id))
          // auto-open is a convenience; the server keeps running
          .catch((error) => noteIgnored("open a dev server's page in its chat", error));
      },
      onExit: (s) =>
        s.status !== 'stopped' &&
        browser.tabs?.change(s.chatId, `preview_exited ${s.id}${s.exitCode != null ? ` with code ${s.exitCode}` : ''}: see preview_logs`),
    });
    if (live.chatDeletion && !deletionOwners.has(live.chatDeletion)) {
      deletionOwners.add(live.chatDeletion);
      const previews = devPreviews;
      addHook(live.chatDeletion, 'onDeleted', (receipt) => previews.stopChat(receipt.chatId));
    }
    // before-quit stops them once the exit gate passed; will-quit does it again in case before-quit was skipped, and
    // when the process exits, a server that hasn't gone (it ignored SIGTERM) is killed: nothing outlives the app
    app.on('will-quit', () => {
      devPreviews?.stopAll({ preserveSaved: true });
      browserShim?.close();
    });
    process.once('exit', () => devPreviews?.killNow());
    registerPreviewTools(live.capabilities, {
      previews: devPreviews,
      open: openInPane,
      projectOf: chatProject,
      localDataAllowed: (chatId) => (live.hostOwnership?.get(chatId).hostId ?? 'local') === 'local',
      anchor: (ctx) => browser.grants.anchor(ctx),
      enabled: previewsOn,
      // its own card ("Run `npm run dev` in … to start a dev server?", Allow for this chat / Deny)
      confirm: async ({ chatId, signal }, { command, cwd }) => {
        const answer = await live.computerUse.broker.ask(
          chatId,
          'devServer',
          { harness: live.controller.ref(chatId).kind, command, cwd, tool: 'browser_preview_start' },
          { signal },
        );
        return answer?.decision === 'allow';
      },
    });
  }

  return {
    registerDevPreviews,
    prepare: (chat, url) => devPreviews?.prepare(chat, url) ?? null,
    get devPreviews() {
      return devPreviews;
    },
    get browserShim() {
      return browserShim;
    },
  };
}

module.exports = { createDevPreviewWiring };
