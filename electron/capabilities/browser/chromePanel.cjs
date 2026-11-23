// The Chrome side panel's requests (MoPilot's extension, sidepanel.html), routed to the remote client service (electron/remote/service.cjs): chats, projects and scheduled tasks for its sidebar, pinning a chat, the harnesses a new chat can use, the model, effort and permission menus and a pick in them, the / menu, a file attached, Dictate, a new chat (in a project) or a follow-up, a chat's rows and cards, answering a card, Stop, and opening MoPilot at a chat or a page.
//
// The extension sends { type: 'panel', id, method, params } on its paired connection and gets back
// { type: 'panel', id, result } or { type: 'panel', id, error }; updates (a watched chat's reply streaming, its turn) go
// as { type: 'panel', event } to the connection that asked last. What each request reads or does is main's
// (app/chromePanel.cjs) and what it accepts is the schema it shares with paired phones (shared/remote/schema.mjs), so
// nothing the panel sends reaches a harness unchecked. Every harness is one id here: 'codex', 'claude' or 'acp:<name>'.
const { messageOf } = require('../../ignored.cjs');
const { CHAT_GONE, CHAT_GONE_TEXT } = require('../../chrome-extension/src/panelErrors.mjs');
const { tabLine } = require('../../../shared/remote/schema.mjs');
const { RemoteService, PANEL } = require('../../remote/service.cjs');
const { stateOf } = require('../../remote/chatState.cjs');

/** The panel's request names, as the service names them. */
const METHOD = {
  browserSettings: 'panel.browserSettings',
  recent: 'chats.recent',
  projects: 'projects.list',
  scheduled: 'scheduled.list',
  pin: 'chats.pin',
  harnesses: 'harnesses.list',
  options: 'options.get',
  commands: 'commands.list',
  dictationEngine: 'dictation.begin',
  dictationEnd: 'dictation.end',
  transcribe: 'chat.transcribe',
  attach: 'chat.attach',
  choose: 'card.choose',
  permit: 'card.permit',
  switch: 'chat.switch',
  start: 'chat.start',
  read: 'chat.read',
  answer: 'card.answer',
  stop: 'chat.stop',
  send: 'chat.send',
  open: 'chat.open',
};

/** A panel request's params as the service's schema has them (the panel names a card's id and choice its own way). */
const paramsOf = (method, p) => (method === 'answer' ? { ...p, cardId: p.approvalId, key: p.choice } : p);

class ChromePanel {
  /**
   * @param {object} o
   * @param {(limit: number, archived: boolean) => Promise<{ id: string, title: string | null, harness: string, at: number,
   *   project: string | null, projectId?: string | null, pinned: boolean }[]>} o.recent the newest chats, as the sidebar lists them (archived: those)
   * @param {() => void} [o.invalidateRecent] retires native-list snapshots after a chat mutation
   * @param {(p: object) => object} o.browserSettings the Chrome name, site grants and exact-origin revocation
   * @param {() => { id: string, name: string }[]} o.projects the saved projects
   * @param {() => Promise<{ id: string, name: string, next: number | null }[]>} o.scheduled the scheduled tasks, soonest first
   * @param {(chatId: string, pinned: boolean) => boolean} o.pin pins or unpins a chat; false when it isn't one
   * @param {(chatId: string) => string | undefined} o.turn the chat's turn now (SessionState.turn)
   * @param {(p: { refresh: boolean }) => Promise<object>} [o.usage] local account usage, without credentials
   * @param {(p: { chatId: string, account: string | null }) => object} [o.setChatAccount] puts a chat on one login of its agent, or back on the agent's own choice
   * @param {() => object} [o.accounts] this Mac's logins per harness and their auto-switch setting, without credentials
   * @param {(p: { harness: string, on: boolean }) => object} [o.setAutoSwitch] turns a harness's auto-switch on or off
   * @param {() => Promise<{ id: string, label: string }[]>} o.harnesses the harnesses a new chat can run on now
   * @param {() => Promise<object[]>} [o.harnessStates] every harness with its state and whether a chat can move to it
   * @param {(harness: string) => Promise<boolean>} o.usable whether that one harness can start a chat now
   * @param {(o: { harness?: string, chatId?: string }) => Promise<object>} o.options the model, effort and permission menus
   *   for a chat, or for a new chat on a harness
   * @param {(o: { harness?: string, chatId?: string, model: string | null, effort: string | null }) => Promise<unknown>} o.choose a
   *   model and effort picked
   * @param {(o: { harness?: string, chatId?: string, value: string }) => Promise<unknown>} o.permit a permission picked
   * @param {(o: { chatId: string, harness: string }) => Promise<unknown>} o.switchHarness the harness a chat's next message
   *   moves it to (its own: a waiting switch cancelled)
   * @param {(o: { harness?: string, chatId?: string, projectId?: string | null }) => Promise<object>} o.commands the / menu
   *   for a chat, or a new chat on a harness (in a saved project)
   * @param {{ engine: () => Promise<string>, begin?: (clientId: string, target: any, generation?: number) => Promise<any>, end?: (capture: string, clientId: string, generation?: number) => Promise<void>, transcribe: (p: { audio: Buffer, mime: string, clip: Buffer, capture?: string, clientId?: string }) => Promise<{ text: string, saveError?: string }> }} o.dictation
   *   Dictate's engine in use, its speech lease (begin and end), and a clip transcribed under that lease
   * @param {(f: { dataUrl: string, name: string }) => { id: string, name: string, kind: string }} o.attach a file kept for a
   *   message (a screenshot of the tab, a file the user picked)
   * @param {(ids: string[]) => any[]} [o.attachmentsForHost] resolve explicitly uploaded images for remote delivery
   * @param {(ids: string[]) => void} [o.attachmentsSent] release uploaded images after durable enqueue
   * @param {(o: { harness: string, text: string, projectId: string | null, model: string | null, effort: string | null, attachments: string[], skills: string[], tab?: any, deadline?: number, retainOnError?: boolean, permission?: string, account?: string, worktree?: boolean, nativeMessageId?: string }) => Promise<string | { chatId: string, warning?: string | null }>} o.start
   *   a new chat with its first message, in a saved project when one is named, on the model and effort picked; its id
   * @param {(chatId: string | null, page?: string) => unknown} o.open shows MoPilot, at the chat or the page named
   * @param {(chatId: string) => Promise<object>} o.read the chat's rows and what it runs on (it is watched from now)
   * @param {(chatId: string, before: string, limit: number) => Promise<{ rows: object[], more: boolean } | null>} [o.older] a page of rows before the row named, for a phone paging back; null when that row is gone
   * @param {(chatId: string) => (() => void) | undefined} [o.sendCheck] captures main’s Stop epoch when a panel message is accepted
   * @param {(o: { chatId: string, text: string, model: string | null, effort: string | null, attachments: string[], skills: string[], tab?: any, deadline?: number }, assertCurrent?: () => void, admit?: () => void) => Promise<unknown>} o.send a
   *   follow-up in the chat (queued while it runs), on the model and effort picked
   * @param {(o: { chatId: string, approvalId: string | number, choice: string, values?: any, version?: string }) => Promise<boolean>} o.answer one of a
   *   waiting card's choices; false when the card is gone (answered elsewhere, withdrawn)
   * @param {(chatId: string) => Promise<unknown>} o.stop stops the chat's turn
   * @param {object} [o.remote] what paired phones are told and allowed (RemoteService's options besides ops)
   * @param {any} [o.state] the SessionStore, for paired phones
   * @param {(chatId: string) => boolean} [o.reachable] whether a chat may be opened, read or written to
   * @param {(chatId: string) => Promise<any[]>} [o.cardsOf] the cards up in a chat, each with its version
   * @param {(approval: object, key: string, agent: string) => object | null} [o.cardAnswer] the result a card's key stands for (MoMo's cards for phones)
   * @param {(p: { chatId: string, query: string }) => Promise<{ chats: object[], files: object[] }>} [o.mentionsList] the chats and files an @ menu lists (app/chromePanelAt.cjs)
   * @param {(p: { harness: string, projectId: string | null, query: string }) => Promise<{ chats: object[], files: object[] }>} [o.mentionsStart] the same for a chat about to start in a saved project
   * @param {(chatId: string, n: number) => Promise<{ itemsShape: string, items: unknown[] }>} [o.items] the chat's last `n` items
   * @param {object} [o.mirror] what the phones' terminal and frame mirrors read (app/chromePanelMirror.cjs)
   * @param {{ folderOf: (chatId: string) => Promise<string | null>, files: (q: any) => Promise<any>, turnDiff: (chatId: string, turnId: string | null) => Promise<{ turnId: string, diff: string, live: boolean } | undefined> }} [o.review] the review methods' reads (electron/remote/review/ops.cjs)
   */
  constructor(o) {
    this.o = o;
    this.service = new RemoteService({ ops: o, goneText: CHAT_GONE_TEXT, ...o.remote });
    /** @type {((message: object) => void) | null} the connection the last request came on */
    this.last = null;
  }

  /** The follow-ups waiting per chat, and who owns them (the service keeps them for the panel and for phones). */
  get sends() {
    return this.service.sends;
  }

  get sendOwners() {
    return this.service.sendOwners;
  }

  /** One update for the panels, on the connection that asked last (none yet: nobody to tell). */
  push(/** @type {object} */ event) {
    this.last?.({ type: 'panel', event });
  }

  /**
   * One request from the panel, answered through `reply` (the extension's connection the request came on).
   * @param {any} m @param {(message: object) => void} reply
   */
  async handle(m, reply) {
    if (!m || !Number.isSafeInteger(m.id)) return;
    this.last = reply;
    try {
      reply({ type: 'panel', id: m.id, result: await this.#call(String(m.method), m.params ?? {}) });
    } catch (error) {
      const message = messageOf(error);
      reply({ type: 'panel', id: m.id, error: message, ...(m.method === 'read' && message === CHAT_GONE_TEXT ? { code: CHAT_GONE } : {}) });
    }
  }

  async #call(method, p) {
    if (!Object.hasOwn(METHOD, method)) throw new Error(`Unknown side panel request: ${method}`);
    return this.service.call(PANEL, METHOD[method], paramsOf(method, p));
  }
}

module.exports = { ChromePanel, tabLine, stateOf };
