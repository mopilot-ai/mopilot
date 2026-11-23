// The in-app browser's secure credential hand-off (browser_request_credentials): the user gives a login in MoPilot's own sheet, main fills it into the page over CDP, and the model only gets a status.
//
// The agent names the sign-in fields (refs) or lets the page agent find them (username, password,
// one-time code). The sheet in the chat (BrowserCredentialSheet.tsx) names the exact site origin, and
// the frame's when the fields sit in a frame from another origin, and the fields; the user types the
// values, picks a login saved in MoPilot (credentialStore.cjs), says they will sign in themselves,
// or declines. Main checks the origin did not change between showing the sheet and filling, focuses
// each field in its own frame and inserts the text with Input.insertText, and from then on the page
// agent masks those fields like password fields. The result is a status (filled, declined, origin_changed,
// submission_failed or user_took_over) and nothing else: the
// values never reach tool results, the operation log (which keeps argument names only), narration,
// screenshots or page diffs. The sheet's answer carries the values from the renderer to main only.
//
// IPC: browser:credentialRequests (the open sheets), browser:credentialAnswer (id, answer),
// browser:credentialForget (a saved login's id). Push: browser:credentialRequestsChanged with the list.
const { HANDOFF_CONTINUES } = require('../../../shared/doneContinue.mjs');
const crypto = require('node:crypto');
const { ToolError } = require('../contract/registry.cjs');
const { originOf } = require('./origins.cjs');
const { chord } = require('./keys.cjs');
const { stale, oneLine } = require('./hostUtil.cjs');
const { withCredentialDocument } = require('./credentialDocument.cjs');

const KINDS = ['username', 'password', 'otp'];
const MAX_VALUE = 4096;
const TAKEOVER = Symbol('takeover');

/** What the model is told for each status (never a value). */
const NEXT = {
  filled: 'MoPilot filled the sign-in fields; you never see their values. Read the page again before continuing.',
  declined: 'The user declined to give a login. Ask them in chat how they want to continue; do not ask for the password in chat.',
  origin_changed: 'The page or one of its frames changed before sign-in finished. Read the page again.',
  submission_failed:
    'MoPilot could not fill or submit the sign-in form. Read the page again; if it still asks for a login, call browser_request_signin so the user signs in themselves.',
  user_took_over: `The user is signing in on the page themselves. ${HANDOFF_CONTINUES}`,
};

/** The open sheets, one per waiting browser_request_credentials call, and the user's answers to them. */
class CredentialHandoff {
  /** @param {{ store?: InstanceType<typeof import('./credentialStore.cjs').CredentialStore> | null, onChange?: (list: any[]) => void }} [o] */
  constructor({
    store = null,
    onChange = () => {
      /* nobody shows the sheets */
    },
  } = {}) {
    this.store = store;
    this.onChange = onChange;
    /** id -> { view, resolve } */
    this.pending = new Map();
  }

  /** The open sheets, as the renderer shows them. */
  list() {
    return [...this.pending.values()].map((p) => ({
      ...p.view,
      saved: this.store?.list(p.view.origin) ?? [],
      canSave: !!this.store?.available(),
    }));
  }

  #changed() {
    this.onChange(this.list());
  }

  /**
   * Shows a sheet; resolves with the user's answer, or { action: 'stopped' } when `signal` aborts.
   * @param {{ chatId: string, tabId: string, origin: string, frameOrigin: string, reason: string, fields: { kind: string, label: string }[] }} view
   * @param {AbortSignal | null} [signal]
   * @returns {{ id: string, answer: Promise<any> }}
   */
  ask(view, signal = null) {
    const id = crypto.randomUUID();
    const answer = new Promise((resolve) => {
      const stop = () => this.finish(id, { action: 'stopped' });
      this.pending.set(id, {
        view: { id, ...view },
        resolve: (a) => {
          signal?.removeEventListener('abort', stop);
          resolve(a);
        },
      });
      if (signal?.aborted) return stop();
      signal?.addEventListener('abort', stop, { once: true });
    });
    this.#changed();
    return { id, answer };
  }

  /** Ends a sheet with `answer` (main's own: origin_changed, closed, stopped); false when it is not open. */
  finish(id, answer) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(answer);
    this.#changed();
    return true;
  }

  /**
   * A chat's turn ended or the chat went: its open sheets end as stopped, as its approval cards do, so a call a harness moved to the
   * background never holds a sheet past its turn (#1834). Returns how many ended.
   */
  endChat(chatId) {
    const ids = [...this.pending.values()].filter((p) => p.view.chatId === chatId).map((p) => p.view.id);
    for (const id of ids) this.finish(id, { action: 'stopped' });
    return ids.length;
  }

  /**
   * The user's answer from the sheet: { action: 'fill', values?: { username?, password?, otp? }, savedId?, save? },
   * { action: 'takeover' } or { action: 'decline' }. Anything else is a decline. False when the sheet is not open.
   */
  answer(id, raw) {
    return this.finish(String(id), cleanAnswer(raw));
  }

  /** Forgets a saved login (from the sheet). */
  forget(savedId) {
    const ok = !!this.store?.remove(String(savedId));
    if (ok) this.#changed();
    return ok;
  }
}

/** The renderer's answer, reduced to what main acts on. */
function cleanAnswer(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  if (a.action === 'takeover') return { action: 'takeover' };
  if (a.action !== 'fill') return { action: 'decline' };
  /** @type {Record<string, string>} */
  const values = {};
  for (const k of KINDS) {
    const v = a.values?.[k];
    if (typeof v === 'string' && v && v.length <= MAX_VALUE) values[k] = v;
  }
  return { action: 'fill', values, savedId: typeof a.savedId === 'string' ? a.savedId : null, save: a.save === true };
}

/**
 * The sign-in fields to fill: the ones `refs` name (all in one frame), or the first frame with a
 * password or one-time code field (the top frame first), else the first with a username field.
 * { sessionId, origin, fields: [{ ref, kind, label }] }, or null when there are none.
 * @param {import('./host.cjs').Tab} tab
 */
async function detectFields(tab, refs) {
  if (refs) {
    const sessions = new Set(refs.map((r) => tab.frameOf(r)));
    if (sessions.size > 1) throw new ToolError('Name sign-in fields from one frame only.', 'bad_args');
    const sessionId = [...sessions][0];
    const out = await tab.agent('credentialFields', { refs }, sessionId);
    if (out?.error === 'stale') throw stale(out.ref);
    if (out?.error)
      throw new ToolError(
        `${out.ref} is not a username, password or one-time code field. Read the page again for the right ref.`,
        'bad_args',
      );
    return { sessionId, origin: out.origin, fields: out.fields };
  }
  /** @type {any} */
  let fallback = null;
  for (const sessionId of ['', ...tab.frames.keys()]) {
    // a frame that cannot answer (detached, or navigating away) offers no fields; the scan goes on to the next
    const out = await tab.agent('credentialFields', {}, sessionId).catch((error) => ({ fields: [], error }));
    if (!out?.fields?.length) continue;
    const found = { sessionId, origin: out.origin, fields: out.fields };
    if (out.fields.some((f) => f.kind !== 'username')) return found;
    fallback ??= found;
  }
  return fallback;
}

/**
 * Fills the values into the fields, in their frame, after checking the page and the frame are still on
 * the origins the user saw. Resolves to a status; errors on the way are submission_failed, never a
 * message that could carry a value.
 */
async function fillFields(tabs, tab, ctx, found, origin, values, submit, onSubmit) {
  try {
    return await tabs.run(tab, async () => {
      await tabs.ready(tab, ctx.chatId, { input: true });
      ctx.checkOwner();
      if (originOf(tab.url) !== origin) return 'origin_changed';
      /** @type {any} */
      let last = null;
      for (const f of found.fields) {
        const value = values[f.kind];
        if (!value) continue;
        const r = await tab.agent('credentialFocus', { ref: f.ref, origin: found.origin }, found.sessionId);
        if (r?.error === 'origin') return 'origin_changed';
        if (r?.error) return 'submission_failed';
        ctx.checkOwner();
        await tab.send('Input.insertText', { text: value }, found.sessionId);
        const c = await tab.agent('credentialCheck', { ref: f.ref }, found.sessionId);
        if (!c?.length) return 'submission_failed';
        last = f;
      }
      if (!last) return 'declined';
      ctx.checkOwner();
      if (originOf(tab.url) !== origin) return 'origin_changed';
      if (!submit) return 'filled';
      const s = await tab.agent('credentialCheck', { ref: last.ref, submit: true }, found.sessionId, onSubmit);
      if (s?.error) return 'submission_failed';
      if (!s.submitted) {
        // no form to submit: Enter in the last field, as the user would
        const enter = chord('Enter', tabs.o.platform);
        ctx.checkOwner();
        await tab.send('Input.dispatchKeyEvent', enter.down, found.sessionId, onSubmit);
        ctx.checkOwner();
        await tab.send('Input.dispatchKeyEvent', enter.up, found.sessionId);
      }
      await tabs.settle(tab);
      return 'filled';
    });
  } catch (e) {
    if (e instanceof ToolError && ['tab_closed', 'credential_document_changed', 'aborted', 'unavailable'].includes(e.code)) throw e;
    return 'submission_failed';
  }
}

/** The tool's result: the status on its own line, then what to do next. */
const result = (status, tab) => `status: ${status}\n${NEXT[status]} (tab ${tab.id})`;

/**
 * browser_request_credentials on a tab of this chat. `chromeRoute` names the user's own Chrome when
 * the chat's browser tools drive it (Your Chrome, or the vendor's Chrome path): MoPilot can't fill
 * there, so the model is sent to browser_request_signin.
 * @param {{ tabs: InstanceType<typeof import('./host.cjs').BrowserTabs> | any, handoff: CredentialHandoff, checkOwner?: () => void }} o
 */
async function requestCredentials(o, tab, args, ctx) {
  ctx = { ...ctx, checkOwner: o.checkOwner ?? (() => undefined) };
  ctx.checkOwner();
  await o.tabs.run(tab, () => o.tabs.ready(tab, ctx.chatId));
  const phase = { submitted: false, save: /** @type {(() => void) | null} */ (null) };
  let status;
  try {
    status = await withCredentialDocument(
      tab.backend,
      ctx.signal,
      (signal) => requestOnDocument(o, tab, args, { ...ctx, signal }, phase),
      ctx.checkOwner,
    );
  } catch (error) {
    // Submission may intentionally navigate. The retired scope still forbids every later command.
    if (error?.code !== 'credential_document_changed') throw error;
    status = phase.submitted ? 'filled' : 'origin_changed';
  }
  ctx.checkOwner();
  if (status === TAKEOVER) {
    // their turn now: the call returns and the agent's turn ends, as browser_request_signin's does (#1834)
    o.tabs.requestSignin(tab, { reason: String(args.reason ?? ''), credential: true });
    status = 'user_took_over';
  }
  // Saving the approved login belongs to the request, not to the submitted page's lifetime.
  if (status === 'filled') phase.save?.();
  return result(status, tab);
}

/** Detection, the approval sheet and fill share the document captured after readiness. */
async function requestOnDocument({ tabs, handoff }, tab, args, ctx, phase) {
  ctx.checkOwner();
  const origin = originOf(tab.url);
  if (!origin) throw new ToolError(`Open the sign-in page in ${tab.id} first (browser_navigate), then call this again.`, 'bad_args');
  const refs = Array.isArray(args.refs) && args.refs.length ? args.refs.map(String) : null;
  const found = await tabs.run(tab, async () => {
    await tabs.ready(tab, ctx.chatId);
    return detectFields(tab, refs);
  });
  if (!found?.fields.length)
    throw new ToolError(
      `No username, password or one-time code field on ${tab.id}. Read the page and pass the fields' refs, or call browser_request_signin for other kinds of sign-in.`,
      'no_fields',
    );
  ctx.checkOwner();
  const frameOrigin = found.origin === origin ? '' : found.origin;
  const { id, answer } = handoff.ask(
    {
      chatId: ctx.chatId,
      tabId: tab.id,
      origin,
      frameOrigin,
      reason: oneLine(String(args.reason ?? ''), 200),
      fields: found.fields.map((f) => ({ kind: f.kind, label: f.label })),
    },
    ctx.signal,
  );
  // the page leaving the site the sheet names ends the sheet: nothing is filled
  const moved = () => {
    if (originOf(tab.url) !== origin) handoff.finish(id, { action: 'origin_changed' });
  };
  const gone = () => handoff.finish(id, { action: 'closed' });
  tab.backend.on('did-navigate', moved);
  tab.backend.on('did-navigate-in-page', moved);
  tab.backend.on('destroyed', gone);
  let a;
  try {
    a = await answer;
  } finally {
    tab.backend.off('did-navigate', moved);
    tab.backend.off('did-navigate-in-page', moved);
    tab.backend.off('destroyed', gone);
  }
  ctx.checkOwner();
  if (a.action === 'stopped') throw new ToolError('The turn ended while waiting for the user to give a login.', 'aborted');
  if (a.action === 'closed') throw new ToolError(`Tab ${tab.id} was closed before the user gave a login.`, 'tab_closed');
  if (a.action === 'origin_changed') return 'origin_changed';
  if (a.action === 'decline') return 'declined';
  if (a.action === 'takeover') return TAKEOVER;
  const values = { ...a.values };
  if (a.savedId) {
    const saved = handoff.store?.get(a.savedId, origin);
    if (!saved) return 'submission_failed';
    values.username ??= saved.username;
    values.password ??= saved.password;
  }
  phase.save = () => {
    if (a.save && !a.savedId && values.password) handoff.store?.save(origin, values.username ?? '', values.password);
  };
  return fillFields(tabs, tab, ctx, found, origin, values, args.submit === true, () => {
    phase.submitted = true;
  });
}

/**
 * The sheet's IPC; returns a function that removes it.
 * @param {{ ipcMain: { handle(ch: string, fn: (...a: any[]) => any): void, removeHandler(ch: string): void }, handoff: CredentialHandoff, checkOwner?: () => void }} o
 */
function registerCredentialIpc({ ipcMain, handoff }) {
  ipcMain.handle('browser:credentialRequests', () => handoff.list());
  ipcMain.handle('browser:credentialAnswer', (_e, id, answer) => handoff.answer(id, answer));
  ipcMain.handle('browser:credentialForget', (_e, savedId) => handoff.forget(savedId));
  return () => {
    for (const ch of ['browser:credentialRequests', 'browser:credentialAnswer', 'browser:credentialForget']) ipcMain.removeHandler(ch);
  };
}

module.exports = { CredentialHandoff, requestCredentials, registerCredentialIpc, detectFields, cleanAnswer };
