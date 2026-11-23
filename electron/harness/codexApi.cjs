// The calls a window may make on Codex by name (CODEX_API, served as codex:api): accounts, models, threads, projects.
const crypto = require('node:crypto');
const { CodexLeases, runsOnThreadSettings } = require('./codexLeases.cjs');
const { turnsOrEmpty } = require('./codexUnrecorded.cjs');
const { guardSend } = require('../session/contract/inputGuard.cjs');

/** The calls a window may make by name (`codex:api`, CodexAdapter.api). */
const CODEX_API = new Set([
  'accountRead',
  'accountRateLimits',
  'loginChatgpt',
  'loginCancel',
  'logout',
  'modelList',
  'configRead',
  'configRequirementsRead',
  'threadList',
  'threadSearch',
  'threadRead',
  'threadAttachments',
  'threadTurns',
  'threadRename',
  'threadArchive',
  'threadUnarchive',
  'threadGoal',
  'backgroundTerminals',
  'turnInterrupt',
  'projectList',
  'projectCreate',
  'projectUpdate',
  'projectDelete',
  'projectMove',
  'feedbackUpload',
  'externalConfigDetect',
  'externalConfigImport',
  'mcpStatus',
  'pluginList',
  'skillList',
  'remoteControlRead',
  'remoteControlSet',
  'remoteControlPairing',
  'remoteControlClaimed',
  'remoteControlClients',
  'remoteControlRevoke',
]);

/** App-server methods only main sends: deleting a thread is ChatDeletion's (chats:delete), which retires the chat with it. */
const MAIN_ONLY = new Set(['thread/delete']);
/** The method a window asked to send (codex:request, codex:leased); one only main sends is refused. */
function windowMethod(method) {
  const m = String(method);
  if (m.startsWith('thread/realtime/')) throw new Error('Start and stop native voice through its speech capture owner.');
  if (MAIN_ONLY.has(m)) throw new Error(`A window can't send ${m}; deleting the chat deletes its thread`);
  return m;
}
/**
 * The method of a window's raw request (codex:request). A run on the thread's own settings (a goal change other than a
 * pause, a review) goes through codex:leased instead, which applies the chat's permission first.
 */
function windowRequest(method, params) {
  const m = windowMethod(method);
  if (runsOnThreadSettings(m, params)) throw new Error(`A window sends ${m} through codex:leased, which applies the chat's permission`);
  return m;
}

/** @typedef {InstanceType<typeof import('./codex.cjs').CodexAdapter>} CodexAdapter the adapter these methods run on */

class CodexApi extends CodexLeases {
  /* -- what windows ask the app-server (WP5-1) ------------------------- */
  // A window names what it wants, not an app-server method: each call here is one request the way the
  // store used to send it. A chat's thread comes from its NativeRef (nativeOf), not from the window.
  // `CODEX_API` lists the ones a window may call (`codex:api`); the generic `codex:request` is left for
  // the pages that belong to Codex (plugins, settings).
  /** @this {CodexAdapter} */
  accountRead() {
    return this.request('account/read', { refreshToken: false });
  }
  /**
   * The Remote Control link of this app-server to the user's devices (the computer's, not a chat's).
   * @this {CodexAdapter}
   */
  remoteControlRead() {
    return this.remoteControl.read();
  }
  /**
   * Turn that link on or off; answers the state after.
   * @this {CodexAdapter}
   */
  remoteControlSet(on) {
    return this.remoteControl.set(on === true);
  }
  /**
   * A pairing code for a device to type; and the calls about the devices paired (the link must be up).
   * @this {CodexAdapter}
   */
  remoteControlPairing() {
    return this.remoteControl.pairing();
  }
  /** @this {CodexAdapter} */
  remoteControlClaimed(code) {
    return this.remoteControl.claimed(code);
  }
  /** @this {CodexAdapter} */
  remoteControlClients() {
    return this.remoteControl.clients();
  }
  /** @this {CodexAdapter} */
  remoteControlRevoke(clientId) {
    return this.remoteControl.revoke(clientId);
  }
  /** @this {CodexAdapter} */
  accountRateLimits() {
    return this.request('account/rateLimits/read', {});
  }
  /** @this {CodexAdapter} */
  loginChatgpt() {
    return this.request('account/login/start', { type: 'chatgpt' });
  }
  /** A ChatGPT sign-in the user gave up on (they closed the browser tab): its callback server is stopped. */
  /** @this {CodexAdapter} @param {string} loginId */
  loginCancel(loginId) {
    return this.request('account/login/cancel', { loginId });
  }
  /** @this {CodexAdapter} */
  logout() {
    return this.request('account/logout', {});
  }
  /** @this {CodexAdapter} */
  modelList() {
    const previous = this.defaultsP;
    const info = this.infoP;
    const read = this.request('model/list', { includeHidden: false });
    this.modelListP = read;
    return read.then((result) => {
      // A picker refresh retires the defaults it could have displayed; an older read cannot retire a newer one.
      if (this.modelListP !== read) return result;
      if (this.infoP === info) this.infoP = null;
      if (this.defaultsP === previous) {
        this.defaultsP = null;
        this.defaultsGood = { model: null, effort: null, ...this.defaultsGood, ...modelDefaults(result) };
      }
      return result;
    });
  }
  /** @this {CodexAdapter} */
  configRead() {
    return this.request('config/read', { includeLayers: false });
  }
  /**
   * Policy requirements (e.g. whether a grant may cover every site).
   * @this {CodexAdapter}
   */
  configRequirementsRead() {
    return this.request('configRequirements/read');
  }
  /**
   * A page of threads: limit, cursor, sortKey, archived.
   * @this {CodexAdapter}
   */
  threadList(p = {}) {
    return this.request('thread/list', p);
  }
  /**
   * Threads whose content matches (titles come from threadList with a searchTerm).
   * @this {CodexAdapter}
   */
  threadSearch(term, limit = 30) {
    return this.request('thread/search', { searchTerm: term, limit, sortKey: 'updated_at' });
  }
  /** @this {CodexAdapter} */
  threadRead(threadId) {
    return this.request('thread/read', { threadId }).then((r) => {
      if (this.turnChanges && r.thread?.turns) r.thread.turns = this.turnChanges.restore(threadId, r.thread.turns);
      return r;
    });
  }
  /** @this {CodexAdapter} */
  threadAttachments(threadId, cursor = null) {
    return this.request('thread/attachment/list', { threadId, cursor, limit: 100 });
  }
  /**
   * A page of a thread's turns: limit, cursor, itemsView. A thread with no user message yet has none (codexUnrecorded.cjs).
   * @this {CodexAdapter}
   */
  threadTurns(threadId, p = {}) {
    return turnsOrEmpty(this.request('thread/turns/list', { threadId, ...p })).then((r) => {
      if (this.turnChanges && r.data) r.data = this.turnChanges.restore(threadId, r.data);
      return r;
    });
  }
  /** @this {CodexAdapter} */
  threadRename(threadId, name) {
    // Cancel automatic naming immediately, even if the chosen name matches the provisional one.
    this.titling.delete(threadId);
    return this.request('thread/name/set', { threadId, name });
  }
  /** @this {CodexAdapter} */
  threadArchive(threadId) {
    return this.request('thread/archive', { threadId });
  }
  /** @this {CodexAdapter} */
  threadUnarchive(threadId) {
    return this.request('thread/unarchive', { threadId });
  }
  /** @this {CodexAdapter} @param {string} threadId @param {() => void} [check] */
  threadDelete(threadId, check) {
    const params = { threadId };
    if (!check) return this.request('thread/delete', params);
    guardSend(params, check);
    return this.request('thread/delete', params, { timeoutMs: 5_000, background: true });
  }
  /**
   * The goal of the chat's Codex thread.
   * @this {CodexAdapter}
   */
  threadGoal(chatId) {
    return this.request('thread/goal/get', { threadId: this.codexThread(chatId) ?? chatId });
  }
  /**
   * Commands the chat's Codex thread left running in the background.
   * @this {CodexAdapter}
   */
  backgroundTerminals(chatId) {
    return this.request('thread/backgroundTerminals/list', { threadId: this.codexThread(chatId) ?? chatId });
  }
  /**
   * Interrupt a turn on a thread by its own id: a spawned sub-agent's child thread, which no chat stands for.
   * @this {CodexAdapter}
   */
  turnInterrupt(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId });
  }
  /** @this {CodexAdapter} */
  projectList() {
    return this.request('project/list', {});
  }
  /** @this {CodexAdapter} */
  projectCreate(name, path) {
    return this.request('project/create', { name, roots: [{ path }], idempotencyKey: crypto.randomUUID() });
  }
  /** @this {CodexAdapter} */
  projectUpdate(projectId, name) {
    return this.request('project/update', { projectId, name });
  }
  /** @this {CodexAdapter} */
  projectDelete(projectId) {
    return this.request('project/delete', { projectId });
  }
  /** @this {CodexAdapter} */
  projectMove(projectId, beforeProjectId) {
    return this.request('project/move', { projectId, beforeProjectId: beforeProjectId ?? null });
  }
  /** @this {CodexAdapter} */
  feedbackUpload(p) {
    return this.request('feedback/upload', {
      classification: p.classification,
      reason: p.reason,
      threadId: p.threadId,
      includeLogs: !!p.includeLogs,
    });
  }
  /**
   * Settings and agents another tool left that can be imported (the home folder and these projects).
   * @this {CodexAdapter}
   */
  externalConfigDetect(cwds) {
    return this.request('externalAgentConfig/detect', { includeHome: true, cwds });
  }
  /** @this {CodexAdapter} */
  externalConfigImport(migrationItems) {
    return this.request('externalAgentConfig/import', { migrationItems });
  }
  /** @this {CodexAdapter} */
  mcpStatus() {
    return this.request('mcpServerStatus/list', {});
  }
  /** @this {CodexAdapter} */
  pluginList() {
    return this.request('plugin/list', {});
  }
  /** @this {CodexAdapter} */
  skillList(cwd, forceReload = false) {
    return this.request('skills/list', { cwds: [cwd], forceReload });
  }

  /**
   * One of the calls above, by name, for `codex:api`.
   * @this {CodexAdapter}
   */
  api(name, args) {
    if (!CODEX_API.has(name)) return Promise.reject(new Error(`Unknown Codex call ${name}`));
    return Promise.resolve().then(() => this[name](...(Array.isArray(args) ? args : [])));
  }
}

/** The recommended model and input capabilities in one successful native model/list answer. */
function modelDefaults(list) {
  const models = list?.data ?? [];
  return {
    defaultModel: models.find((m) => m.isDefault)?.model ?? null,
    inputs: Object.fromEntries(models.map((m) => [m.model, m.inputModalities ?? null])),
  };
}

module.exports = { CodexApi, CODEX_API, windowMethod, windowRequest, modelDefaults };
