// The extension's side panel (sidepanel.html), laid out like Claude in Chrome's: the connection's one state until MoPilot is connected, then a chat (new, or one of the recent ones) with the current tab, its reply streaming in.
//
// The composer: the model and permission menus (panelMenus.mjs), + (panelAttach.mjs), / (panelSlash.mjs) and @
// (panelMention.mjs), Dictate (panelDictate.mjs). Everything the panel asks goes through the background ({ type: 'panel', method, params }, panelLink.mjs) to MoPilot, which checks it (electron/capabilities/browser/chromePanel.cjs). MoPilot's updates come back as
// { type: 'panelEvent', event }: the open chat's reply streaming, a change to read, its turn, or the connection changing. Text from MoPilot or a page only
// ever goes in as text.
import { FOLLOW_MS } from './options.mjs';
import { PanelThread, PROGRESS } from './panelThread.mjs';
import { PanelSidebar } from './panelSidebar.mjs';
import { PanelMenus } from './panelMenus.mjs';
import { PanelMenuDismiss } from './panelMenuDismiss.mjs';
import { PanelHarnesses, pickHarness } from './panelHarnesses.mjs';
import { PanelAttach } from './panelAttach.mjs';
import { autosize } from './panelAutosize.mjs';
import { PanelSlash } from './panelSlash.mjs';
import { PanelMention } from './panelMention.mjs';
import { PanelDictate } from './panelDictate.mjs';
import { PanelWelcome } from './panelWelcome.mjs';
import { PanelNotice } from './panelNotice.mjs';
import { PanelTab, tabOf } from './panelTab.mjs';
import { CHAT_GONE, CHAT_GONE_TEXT, reportPanelError, PanelErrors } from './panelErrors.mjs';
import { CONNECTION_LOST } from './panelLink.mjs';

export { PROGRESS };

import { PLACEHOLDER, STATES, stateOf } from './panelConnection.mjs';
import { PanelTips } from './panelTips.mjs';
export { PLACEHOLDER, STATES, stateOf, pickHarness, tabOf };

/** How soon a harness list that failed is asked for again. */
export const HARNESS_AGAIN_MS = 5_000;

/**
 * Starts the panel in its window (`g`: chrome, document, and the window's own timers, called on it).
 * @param {any} g
 */
export function startSidePanel(g) {
  const { chrome, document } = g;
  // the tab this panel was opened on, and the chat kept for it (panelTab.mjs)
  const own = new PanelTab({
    chrome,
    timers: g,
    history: g.history,
    search: String(g.location?.search ?? ''),
    log: (what, e) => reportPanelError(what, e, error),
  });
  const timers = g;
  const $ = (id) => document.getElementById(id);
  /** @type {any} the background's last answer */
  let conn = null;
  let follow = null;
  /** @type {{ id: number, url: string, title: string, icon: string } | null} */
  let tab = null;
  let tabOff = false;
  /** the chat open in the panel */
  let chat = /** @type {{ id: string, title: string } | null} */ (null);
  let sending = false;
  /** @type {{ id: string, name: string } | null} the project a new chat goes into (picked in the sidebar) */
  let project = null;
  let harnessesRead = false;

  const ask = (/** @type {object} */ message) => Promise.resolve(chrome.runtime.sendMessage(message));
  /** One request to MoPilot; rejects with the line to show. */
  const request = async (/** @type {string} */ method, /** @type {any} */ params = {}) => {
    const r = await ask({ type: 'panel', method, params });
    if (r?.error) {
      show(r);
      if (method === 'read' && params.chatId === chat?.id && (r.code === CHAT_GONE || (!r.code && r.error === CHAT_GONE_TEXT))) {
        newChat(null, true, false);
      }
      throw Object.assign(new Error(r.error), { code: r.code });
    }
    if (method === 'read' && chat && params.chatId === chat.id) {
      void menus.observe(params.chatId, r?.result);
      if (r?.result?.title) {
        chat.title = r.result.title;
        $('title').textContent = chat.title;
      }
    }
    return r?.result ?? {};
  };
  const errors = new PanelErrors(document);
  const error = errors.show.bind(errors); // (text, retry?): a retry is the failed action the banner's Retry runs again
  const sidebar = new PanelSidebar({
    document,
    request,
    onPick: (/** @type {any} */ c) => void openChat(String(c.id), String(c.title ?? 'New chat'), { state: c.state }),
    onNew: (p) => newChat(p),
    onOpen: (chatId, page) => void openInApp(chatId, page),
    onSettings: () => void Promise.resolve(chrome.runtime.openOptionsPage()).catch((e) => error(String(e.message))),
    onError: error,
  });
  const harnessList = new PanelHarnesses({
    document,
    select: $('harness'),
    request,
    setMenu: (list) => menus.setHarnesses(list),
    log: (what, e) => own.log(what, e),
  });
  const menus = new PanelMenus({
    document,
    request,
    onError: error,
    onHarness: (id) => (($('harness').value = id), harnessPicked()),
    onModelMenu: () => void harnessList.refresh(),
  });
  // the model, permission and + menus close on Escape and on a press outside them
  new PanelMenuDismiss({ document, close: () => menus.close() });
  /** The next new chat's harness picked: its / menu and model menus follow. */
  const harnessPicked = () => {
    slash.reset();
    sync();
    newChatMenus();
  };
  const attach = new PanelAttach({
    document,
    chrome,
    request,
    read: (/** @type {any} */ file) =>
      new Promise((resolve, reject) => {
        const r = new g.FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
        r.readAsDataURL(file);
      }),
    tab: () => tab,
    onError: error,
    onChange: () => sync(),
  });
  /** The menus for the next new chat, on the harness picked. */
  const newChatMenus = () => {
    const select = $('harness');
    if (!chat && select.value) void menus.load({ harness: select.value });
  };
  const draftChanged = () => {
    own.changed();
    sync();
  };
  /** The chat open, or the next new chat on the harness picked, in the project picked. */
  const chatTarget = () => (chat ? { chatId: chat.id } : { harness: $('harness').value, ...(project ? { projectId: project.id } : {}) });
  const slash = new PanelSlash({
    document,
    request,
    target: chatTarget,
    onError: error,
    onChange: draftChanged,
  });
  const mention = new PanelMention({ document, chrome, request, onError: error, onChange: draftChanged });
  new PanelDictate({
    target: () => ({ composerRevision: own.revision, ...chatTarget(), ...menus.pick, projectId: project?.id ?? null }),
    document,
    chrome,
    g,
    request,
    // added after what is typed, as the app's Dictate adds it
    onText: (/** @type {string} */ t) => {
      const box = $('text');
      box.value = (box.value ? `${box.value} ` : '') + t;
      draftChanged();
      box.focus();
    },
    onError: error,
  });
  const thread = new PanelThread({
    document,
    request,
    onError: error,
    onOpen: (chatId) => void openInApp(chatId),
    // Send turns into Stop while the open chat's turn runs
    onTurn: () => sync(),
    onRetry: (text) => void send(text),
    timers,
  });
  // the first run's consent and intro stand before the chat; the greeting lists the scheduled tasks
  const welcome = new PanelWelcome({ document, chrome, request, onOpen: (page) => void openInApp(null, page), onChange: () => show(conn) });
  const notice = new PanelNotice({ document, ask, onError: error });
  const tips = new PanelTips(g);
  /** "Ask MoPilot" in a page's context menu: its selected text, for this tab's panel, goes in the box */
  let draftTab = null;
  const takeDraft = async () => {
    draftTab = await own.takeDraft($('text'), ask, sync);
  };
  const draftFailed = (/** @type {unknown} */ e) => own.log('restore this tab’s draft', e);

  /** Shows the connection's state, or the panel's chat once connected. */
  function show(/** @type {any} */ r) {
    conn = r;
    const st = stateOf(r);
    $('state').hidden = !st;
    // a first-run step stands before the chat: the composer waits
    const first = !st && welcome.blocking;
    $('welcome').hidden = !!st || !welcome.blocking;
    $('composer').hidden = !!st || first;
    $('new').hidden = !!st;
    $('app').hidden = !!st;
    $('empty').hidden = !!st || first || !!chat;
    $('chat').hidden = !!st || first || !chat;
    $('title').textContent = st ? 'MoPilot' : (chat?.title ?? 'New chat');
    $('task-title').hidden = !!st || first || !chat;
    $('meta').hidden = !chat;
    tips.sync(!chat);
    // a new chat goes into the project the sidebar picked
    $('project').hidden = !!chat || !project;
    $('project-name').textContent = project ? `In ${project.name}` : '';
    $('side').hidden = !!st;
    if (st) {
      sidebar.close();
      $('spin').hidden = !st.spin;
      $('state-title').textContent = st.title;
      $('state-text').textContent = r?.error && !st.spin ? r.error : st.text;
      $('state-act').hidden = !st.act;
      $('state-act').textContent = st.act ?? '';
      $('state-act').dataset.send = st.send ?? '';
    } else if (!harnessesRead) {
      harnessesRead = true;
      void loadHarnesses();
      void welcome.start();
      void welcome.pinTip();
      void reopen().catch((e) => own.log('restore this tab’s chat', e));
    }
    timers.clearTimeout(follow);
    follow = null;
    // a state that may change by itself is asked again (the background's updates are missed while it sleeps)
    const settling = r?.asking ? 'asking' : r?.starting ? 'starting' : String(r?.status);
    const ms = st ? (FOLLOW_MS[settling] ?? FOLLOW_MS.connecting) : 0;
    if (ms) follow = timers.setTimeout(() => void refresh(), ms);
  }
  const refresh = () => ask({ type: 'status' }).then(show);

  async function loadHarnesses() {
    try {
      const { harnesses = [] } = await request('harnesses');
      const saved = await chrome.storage.local.get('panelHarness');
      harnessList.apply(harnesses, saved?.panelHarness);
      if (!harnesses.length) error('No harness can start a chat now. Check Settings in MoPilot.');
      newChatMenus();
    } catch (e) {
      error(String(/** @type {Error} */ (e).message));
      // asked again shortly while connected (a harness slow to answer the first time)
      timers.setTimeout(() => {
        if (!stateOf(conn)) void loadHarnesses();
        else harnessesRead = false;
      }, HARNESS_AGAIN_MS);
    }
    sync();
  }

  /** The send button and the tab chip follow what is typed and which tab is in front. */
  function sync() {
    own.keepDraft($('text').value);
    autosize($('text'));
    tips.sync(!chat);
    // a file still being added goes with the message, so Send waits for it
    $('send').disabled = sending || attach.busy > 0 || !$('text').value.trim() || (!chat && !$('harness').value);
    // with the box empty, the button stops the turn that runs (typing queues a follow-up instead)
    const stop = !!chat && thread.state === 'running' && !$('text').value.trim();
    $('stop').hidden = !stop;
    $('send').hidden = stop;
    const t = tabOff ? null : tab;
    $('tab').hidden = !tab;
    $('tab-title').textContent = tab?.title ?? '';
    $('tab-off').textContent = t ? "Don't include this tab" : 'Include this tab';
    $('tab-off').setAttribute('aria-label', $('tab-off').textContent);
    $('tab-off').setAttribute('aria-pressed', String(!!t));
    $('tab-icon').hidden = !t?.icon;
    if (t?.icon) $('tab-icon').src = t.icon;
  }

  async function readTab() {
    const next = tabOf(await own.read());
    // another tab in front brings the chip back
    if (next?.id !== tab?.id) tabOff = false;
    tab = next;
    sync();
    await notice.read(next?.id ?? null);
  }

  /** Once connected, the tab's panel shows the chat kept for the tab, else the chat whose tab group the tab is in. */
  const reopen = () => own.restore(ask, () => !!chat, openChat);

  /** Opens a chat in the panel: the message just sent shows at once, then its rows from MoPilot. */
  function openChat(
    /** @type {string} */ id,
    /** @type {string} */ title,
    /** @type {{ sent?: string, state?: string, persist?: boolean, preserveSkills?: boolean }} */ o = {},
  ) {
    chat = { id, title: Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, 80).join('') };
    if (o.persist === false) own.revision++;
    else own.bind(chat);
    if (!o.preserveSkills) slash.reset();
    error('');
    show(conn);
    sync();
    void menus.load({ chatId: id });
    return thread.open(id, o);
  }
  function newChat(/** @type {{ id: string, name: string } | null} */ inProject = null, preserveInput = false, explicit = true) {
    chat = null;
    own.bind(null, explicit);
    project = inProject;
    slash.reset();
    thread.close();
    if (!preserveInput) $('text').value = '';
    sync();
    error('');
    show(conn);
    newChatMenus();
    $('text').focus();
  }

  /**
   * Sends the box's message, or `resend` (Retry: the open chat's last message again, leaving the box, its files and skills alone).
   * @param {string} [resend]
   */
  async function send(resend) {
    const fromBox = resend === undefined;
    const text = (resend ?? $('text').value).trim();
    const harness = $('harness').value;
    if (!text || (!chat && !harness) || sending || (fromBox && attach.busy)) return;
    const source = chat,
      revision = own.revision,
      draftRevision = own.draftRevision;
    const current = () => chat === source && own.revision === revision;
    sending = true;
    error('');
    sync();
    const sent = fromBox ? attach.ids : [];
    const skills = fromBox ? [...slash.skills] : [];
    try {
      const t = tabOff ? null : tab;
      const context = {
        ...(t ? { tab: { id: t.id, url: t.url, title: t.title } } : {}),
        ...(sent.length ? { attachments: sent } : {}),
        ...(skills.length ? { skills } : {}),
      };
      if (chat) {
        // a follow-up in the open chat, shown as it is sent: it runs now, or after the turn that runs
        if (fromBox) $('text').value = '';
        thread.sending(text);
        try {
          const { warning } = await request('send', { chatId: chat.id, text, ...context, ...menus.pick });
          attach.clear(sent);
          if (warning) error(current() ? String(warning) : `For the earlier message: ${warning}`);
          if (!current()) return;
          slash.clear(skills);
        } catch (e) {
          if (current() && e.code !== 'delivery_unconfirmed') {
            thread.unsent(text);
            if (fromBox && own.draftRevision === draftRevision) $('text').value = text;
          }
          throw e;
        }
        void thread.read();
      } else {
        const {
          chatId,
          warning,
          error: sendError,
        } = await request('start', {
          retainOnError: true,
          harness,
          text,
          ...context,
          ...menus.pick,
          ...(project ? { projectId: project.id } : {}),
        });
        if (!current()) {
          if (sendError) errors.failed(`The earlier message was not sent: ${sendError}`, text, false);
          else {
            attach.clear(sent);
            if (own.draftRevision === draftRevision) $('text').value = '';
            if (warning) error(`For the earlier message: ${warning}`);
          }
          return;
        }
        if (sendError) {
          void openChat(chatId, text.split('\n')[0], { preserveSkills: true });
          errors.failed(String(sendError), text, own.draftRevision === draftRevision);
          return;
        }
        project = null;
        attach.clear(sent);
        slash.clear(skills);
        void chrome.storage.local.set({ panelHarness: harness });
        if (own.draftRevision === draftRevision) $('text').value = '';
        void openChat(chatId, text.split('\n')[0], { sent: text });
        if (warning) error(String(warning));
      }
    } catch (e) {
      if (e.code === 'delivery_unconfirmed') {
        attach.clear(sent);
        if (current()) slash.clear(skills);
        if (fromBox && current() && own.draftRevision === draftRevision) $('text').value = '';
        if (current() && chat) {
          thread.unsent(text);
          void thread.read();
        }
        errors.failed(String(e.message), text, false);
        return;
      }
      // the text stays in the box to send again (a Retry's was never in it); the banner's Retry sends the box again after a lost transport
      const inBox = fromBox && current() && own.draftRevision === draftRevision;
      errors.failed(String(/** @type {Error} */ (e).message), text, inBox, e.code === CONNECTION_LOST ? () => void send() : undefined);
    } finally {
      sending = false;
      sync();
    }
  }

  async function openInApp(/** @type {string | null} */ chatId, /** @type {string} */ page = '') {
    try {
      await request('open', page ? { page } : chatId ? { chatId } : {});
    } catch (e) {
      error(String(/** @type {Error} */ (e).message));
    }
  }

  $('state-act').addEventListener('click', (/** @type {any} */ e) => {
    const what = e.currentTarget.dataset.send;
    if (what) void ask({ type: what }).then(show, (/** @type {any} */ err) => show({ ...conn, error: String(err.message) }));
  });
  // the sidebar: the bar's ☰ and the title open it, as Claude's panel does
  const toggleSidebar = () => {
    if (sidebar.shown || stateOf(conn)) return sidebar.close();
    void sidebar.open();
  };
  $('side').addEventListener('click', toggleSidebar);
  $('title').addEventListener('click', toggleSidebar);
  $('new').addEventListener('click', () => newChat());
  $('project-off').addEventListener('click', () => {
    project = null;
    // a skill picked for the project's folder isn't the home folder's
    slash.reset();
    show(conn);
  });
  $('app').addEventListener('click', () => void openInApp(chat?.id ?? null));
  $('tab-off').addEventListener('click', () => {
    tabOff = !tabOff;
    sync();
  });
  $('text').addEventListener('input', () => {
    draftChanged();
    void slash.update();
    void mention.update();
  });
  $('text').addEventListener('keydown', (/** @type {any} */ e) => {
    // the / menu's keys first: Enter picks a command there rather than sending
    if (slash.key(e) || mention.key(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  $('composer').addEventListener('submit', (/** @type {any} */ e) => {
    e.preventDefault();
    void send();
  });
  $('harness').addEventListener('change', harnessPicked);
  $('stop').addEventListener('click', () => {
    const id = chat?.id;
    if (!id) return;
    request('stop', { chatId: id }).then(
      () => thread.read(),
      (e) => error(String(/** @type {Error} */ (e).message)),
    );
  });
  chrome.runtime.onMessage.addListener((/** @type {any} */ m) => {
    if (m?.type !== 'panelEvent') return;
    const e = m.event ?? {};
    if (e.kind === 'tabReplaced' && own.id === e.removed) {
      own.follow(e.added);
      void takeDraft().catch(draftFailed);
      if (e.failed) error("This tab's panel could not be restored. Keep this panel open to preserve your chat and draft.");
      return void readTab();
    }
    if (e.kind === 'status') return void refresh();
    if (e.kind === 'tabNotice') return void notice.read(tab?.id ?? null);
    if (e.kind === 'draft') return void (e.tabId === (own.id ?? draftTab) && takeDraft().catch(draftFailed));
    // only the open chat's updates
    if (!chat || e.chatId !== chat.id) return;
    if (e.kind === 'delta') thread.delta(String(e.text ?? ''));
    else if (e.kind === 'changed') void thread.read();
    else if (e.kind === 'turn') {
      thread.turn(e.state);
      // the turn ended or waits: its rows as they are now
      if (e.state !== 'running') void thread.read();
    }
  });
  // a panel opened without its tab follows the tab in front; a tab's own panel reads only its tab
  chrome.tabs.onReplaced.addListener((_added, removed) => own.retire(removed));
  chrome.tabs.onRemoved.addListener((id) => own.retire(id));
  chrome.tabs.onActivated.addListener(() => own.followsFront && void readTab());
  // the panel's tab changed its page, title or icon (one that wasn't a web page may have become one)
  chrome.tabs.onUpdated.addListener((/** @type {number} */ id, /** @type {any} */ change, /** @type {any} */ t) => {
    if (own.follows(id, t) && (change.title || change.url || change.favIconUrl)) void readTab();
  });
  g.addEventListener?.('pagehide', () => own.flushDraft());
  return { refresh, ready: Promise.all([refresh(), readTab(), takeDraft().catch(draftFailed)]) };
}
