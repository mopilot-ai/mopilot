// The Codex adapter's threads and turns: start and fork, turns, steers and goals the controller sends, and helper turns.
const { clock } = require('../platform/ports/clock.cjs');
const crypto = require('node:crypto');
const { assertCodexRef } = require('./codexRef.cjs');
const { provisionalTitle, titlePrompt } = require('../../shared/title.mjs');
const { landTitle, TITLE_MS } = require('./autoTitle.cjs');
const { permissionParams, buildInput, turnParams, chatPrefs, historyParams, withMomoParams } = require('./codexParams.cjs');
const { momoContextFor, forgetMomoSent } = require('../momo/contract/context.cjs');
const { ThreadLocked } = require('./codexLeases.cjs');
const { CodexApi, modelDefaults } = require('./codexApi.cjs');
const { noteIgnored, ignoring, messageOf } = require('../ignored.cjs');
const { assertInputCurrent, carryInputGuard, inputIsGuarded, clientIdOf } = require('../session/contract/inputGuard.cjs');
const { ISOLATED_THREAD } = require('./codexIsolation.cjs');
const { effectiveModel } = require('../../shared/modelChoice.mjs');

/** A readable message for a failed goal request (src/lib/codexGoals.ts goalErrorMessage). */
function goalErrorMessage(e) {
  const msg = String(e?.message ?? e);
  if (/goals feature is disabled/i.test(msg)) return 'Goals are turned off in Codex settings';
  if (/ephemeral thread/i.test(msg)) return "Temporary chats can't have goals";
  return msg;
}

const INFO_TTL_MS = 30_000;
/** How long an answer without the model list is kept before the list is asked for again. */
const FAILED_INFO_TTL_MS = 5_000;

/** @typedef {InstanceType<typeof import('./codex.cjs').CodexAdapter>} CodexAdapter the adapter these methods run on */

class CodexTurns extends CodexApi {
  /** @type {((parentThread: string, forkThread: string) => unknown) | undefined} a fork that keeps the parent's history was made (app/chatPicturesWiring.cjs) */
  onFork = undefined;

  /* -- threads ------------------------------------------------------ */
  /**
   * thread/start; the new thread is loaded here, so Sage holds it. `onThread(id)` runs as soon as the
   * answer names the thread, before the lease or any of the thread's notifications (a switch claims it for its chat).
   * @this {CodexAdapter}
   * @param {any} params
   * @param {{ onThread?: (threadId: string) => void }} [opts]
   */
  async startThread(params, opts = {}) {
    // fail closed: a start marked as a MoMo chat's, on an adapter that was never told which chats are MoMo's, runs nowhere
    if (params?.[ISOLATED_THREAD] && !this.isolation.decides)
      throw new Error("MoMo's Codex chat can't start: Codex isn't set up to keep MoMo's chats apart yet");
    const { onThread } = opts;
    const onAnswer = onThread && ((r) => r?.thread?.id && onThread(r.thread.id));
    const r = await this.request('thread/start', params, { onAnswer });
    if (r?.thread?.id) {
      // nothing of it is on disk until its first message: kept loaded until then (releaseIdle)
      this.unrecorded.add(r.thread.id);
      this.hold(r.thread.id, r.thread);
    }
    return r;
  }
  /**
   * thread/fork; `hold` for a fork Sage writes right away (a side chat).
   * @this {CodexAdapter}
   * @param {import('./codexOutgoing.cjs').CodexForkReceipt} [fork] a Host fork's live ownership and reply validation
   */
  async fork(params, hold = false, fork) {
    const r = await this.request('thread/fork', params, { fork });
    if (r?.thread?.id) {
      this.meta.set(r.thread.id, r.thread);
      if (hold) this.hold(r.thread.id, null);
      // a fork that keeps the history names the parent's pictures by path (platform/chatPictures.cjs)
      if (!params?.excludeTurns && !params?.ephemeral && typeof params?.threadId === 'string') {
        try {
          await this.onFork?.(params.threadId, r.thread.id);
        } catch (error) {
          noteIgnored("share a forked chat's pictures", error);
        }
      }
    }
    return r;
  }

  /**
   * What the capability resolver reads (electron/session/caps.cjs): the negotiation (version, probes,
   * the harness's own feature flags) and the model list. Only once the app-server is up (asking never starts a Codex no
   * one asked for); kept for a short while, and dropped when the process goes.
   * @returns {Promise<{ version: string|null, models: any[], negotiated: { cliVersion: string|null, versionStatus: string|null, probes: any, flags: any } | null | undefined } | null>}
   * @this {CodexAdapter}
   */
  async info() {
    if (!this.readyAt || this.down) return null;
    if (this.infoP && this.now() - this.infoAt < INFO_TTL_MS) return this.infoP;
    this.infoAt = this.now();
    // a failed model list answers no models now, and is kept only briefly: a call after that asks again
    let modelsFailed = false;
    const models = this.request('model/list', { includeHidden: false }).catch((error) => {
      modelsFailed = true;
      noteIgnored('list the Codex models', error);
      return null;
    });
    const p = Promise.all([this.negotiation(), models]).then(([negotiated, list]) => {
      if (modelsFailed && this.infoP === p) this.infoAt = this.now() - INFO_TTL_MS + FAILED_INFO_TTL_MS;
      return { version: negotiated?.cliVersion ?? null, models: list?.data ?? [], negotiated };
    });
    this.infoP = p;
    p.catch(() => this.infoP === p && (this.infoP = null));
    return p;
  }

  /**
   * The config effort and current recommended model, kept briefly between turns. Failed refreshes keep the last good
   * answer and retry next time; a read under way is shared even after the previous answer expired.
   * @this {CodexAdapter}
   */
  defaults() {
    const age = this.now() - (this.defaultsAt ?? 0);
    if (!this.defaultsP || (this.defaultsAt !== null && (age < 0 || age >= INFO_TTL_MS))) {
      const previous = this.defaultsGood;
      this.defaultsAt = null;
      let configFailed = false;
      let modelsFailed = false;
      const p = Promise.all([
        this.request('config/read', { includeLayers: false }).catch(() => ((configFailed = true), null)),
        this.request('model/list', { includeHidden: false }).catch(() => ((modelsFailed = true), null)),
      ]).then(([c, m]) => {
        const result = {
          model: (configFailed ? previous?.model : c?.config?.model) ?? null,
          effort: (configFailed ? previous?.effort : c?.config?.model_reasoning_effort) ?? null,
          ...(modelsFailed ? { defaultModel: previous?.defaultModel ?? null, inputs: previous?.inputs ?? {} } : modelDefaults(m)),
        };
        if (this.defaultsP === p) {
          this.defaultsAt = this.now();
          if (configFailed || modelsFailed) this.defaultsP = null;
          if (!configFailed || !modelsFailed) this.defaultsGood = result;
        }
        return result;
      });
      this.defaultsP = p;
    }
    return this.defaultsP;
  }

  /* -- turns (the ChatController calls these) ------------------------ */
  /**
   * Start a turn for a queued message on the chat's Codex thread. Windows follow it through item
   * events: turnStarting (the optimistic bubble), then turnStarted or turnFailed.
   * @returns {Promise<{ started: boolean, turnId?: string, held?: boolean, error?: string }>} held: not started, a window holds it (writer lock)
   * @this {CodexAdapter}
   */
  async startTurn(chatId, ref, item, origin = null) {
    const nid = assertCodexRef(ref).id;
    try {
      await this.ensureResumed(nid);
      // an idle release asking Codex meanwhile sees the thread in use and keeps it
      this.touch(nid);
      // a stopped native turn must have ended; the plugin's release does not hold the new turn
      await this.nativeLifecycle.turnEnded(nid);
    } catch (e) {
      // another Codex client holds it: a window that takes the message holds it until the lock is let go, and sends
      // it then; main keeps it queued only when no window took it (else both would send it)
      if (e instanceof ThreadLocked) {
        // Automatic deliveries retain their durable owner; renderer held-input retries cannot carry it.
        if (inputIsGuarded(item)) return { started: false };
        if (item.opts?.retainInMain) return { started: false, error: messageOf(e) };
        return { started: false, held: !!this.emit({ kind: 'locked', chatId, item }, origin ?? 'any') };
      }
      const error = String(e?.message ?? e);
      this.emit({ kind: 'toast', level: 'error', text: `Couldn't open this chat for writing: ${error}` }, origin ?? 'any');
      return { started: false, error };
    }
    this.touch(nid);
    const prefs = chatPrefs(this.prefs() || {}, this.chatConfig(chatId));
    // a chat with none of its own (made before D-29, or elsewhere) keeps these from now on: another chat's pick moves only the defaults
    this.keepSelection?.(chatId, { model: prefs.model ?? null, effort: prefs.effort ?? null, serviceTier: prefs.serviceTier ?? null });
    const meta = this.meta.get(nid) || {};
    const first = !meta.preview;
    const clientId = clientIdOf(item);
    this.emit({
      kind: 'turnStarting',
      chatId,
      clientId,
      itemId: item.id,
      text: item.text,
      attachments: item.attachments || [],
      opts: item.opts || {},
      origin,
    });
    // a new chat is named at send: its title helper runs in a hidden thread beside this turn
    // an isolated chat (MoMo's) is in no list and gets no generated title: its first message never goes to a second thread
    const titled = chatId === nid && first && !meta.name && !meta.ephemeral && this.isolation?.isolated(chatId) !== true;
    /** @type {string | null} */
    let momo = null;
    try {
      // The start snapshot runs alongside turn/start: the model writes only through tool items, and one that starts
      // before the snapshot is taken leaves the turn to Codex's own attribution (TurnChanges.itemStarted).
      this.turnChanges?.begin(nid, meta.cwd);
      const defaults = await this.defaults();
      // computer use's authorization anchor follows the sandbox this turn runs with (read-only is the read-only tier)
      this.state?.patch(chatId, { permission: prefs.permission ?? 'default' });
      // computer use answers with what this model takes in (a screenshot, or the element list)
      try {
        const model = effectiveModel(item.opts?.model ?? prefs.model, defaults.defaultModel, defaults.model);
        const inputs = defaults.inputs?.[model ?? ''];
        this.state?.patch(chatId, {
          modality: Array.isArray(inputs) && inputs.length ? (inputs.includes('image') ? 'image' : 'text') : null,
        });
      } catch (error) {
        // Optional display metadata cannot prevent the prompt from reaching the model.
        noteIgnored('read what the Codex model takes in', error);
      }
      assertInputCurrent(item);
      // a MoMo chat's memory rides along with a new turn when the thread wasn't given this one yet, never with a steer
      momo = momoContextFor(chatId, { session: nid, query: item.text });
      const params = withMomoParams(turnParams(nid, clientId, item, prefs, meta.cwd, defaults), momo);
      const r = await this.request('turn/start', carryInputGuard(item, params));
      const turnId = r.turn.id;
      if (!meta.preview && this.meta.has(nid)) this.meta.get(nid).preview = item.text;
      // the model and effort asked for, as the request ledger records them (electron/ledger/codexTap.cjs)
      const { model, reasoning_effort: effort } = params.collaborationMode.settings;
      this.emit({
        kind: 'turnStarted',
        chatId,
        clientId,
        turnId,
        text: item.text,
        human: item.opts?.human === true,
        model: model || null,
        effort,
      });
      // the chat keeps its current name when naming it fails
      if (titled) this.autoTitle(nid, item.text).catch(ignoring('name a new Codex chat'));
      return { started: true, turnId, ...(item.peer ? { itemId: clientId } : {}) };
    } catch (e) {
      // a turn that didn't start gives its memory back, so the next one carries it
      if (momo) forgetMomoSent(chatId, nid);
      this.turnChanges?.abort(nid);
      this.emit({ kind: 'turnFailed', chatId, clientId, error: String(e?.message ?? e) });
      return { started: false, error: String(e?.message ?? e) };
    }
  }

  /**
   * A follow-up into the running turn. The app-server refuses it once that turn has ended
   * (expectedTurnId); the ChatController then sends it as the next turn, so nothing is said here. It
   * names the message (clientUserMessageId): the app-server's userMessage item carries that id, and
   * its notifications can reach the windows before this answer does, so they show the message once.
   * @this {CodexAdapter}
   */
  async steer(chatId, ref, item, origin = null) {
    assertCodexRef(ref);
    const turnId = this.state?.get(chatId)?.activeTurn?.id ?? null;
    if (!turnId) return this.startTurn(chatId, ref, item, origin);
    const clientId = clientIdOf(item);
    try {
      const receipt = await this.request(
        'turn/steer',
        carryInputGuard(item, {
          threadId: ref.id,
          input: buildInput(item.text, item.attachments || []),
          ...historyParams(item.attachments || []),
          expectedTurnId: turnId,
          clientUserMessageId: clientId,
        }),
      );
      this.touch(ref.id);
      this.emit({ kind: 'steered', chatId, turnId, text: item.text, attachments: item.attachments || [], clientId });
      return { started: true, ...(item.peer ? { turnId: receipt?.turnId ?? turnId, itemId: clientId } : {}) };
    } catch (e) {
      return { started: false, error: String(e?.message ?? e) };
    }
  }

  /**
   * Set a goal. thread/goal/set starts its own turn and writes no user message, so the windows show
   * the command itself. An active goal counts as a started turn.
   * @this {CodexAdapter}
   */
  async startGoal(chatId, ref, item, origin = null) {
    const objective = item.opts.goal;
    const nid = assertCodexRef(ref).id;
    const toast = (text) => (this.emit({ kind: 'toast', level: 'error', text }, origin ?? 'any'), { started: false, error: text });
    try {
      await this.ensureResumed(nid);
    } catch (e) {
      if (!(e instanceof ThreadLocked)) return toast(`Couldn't set goal: ${goalErrorMessage(e)}`);
      this.emit({ kind: 'leaseLocked', chatId }, origin ?? 'any');
      return { started: false };
    }
    // ephemeral threads reject goals, so nothing is sent for them
    if (this.meta.get(nid)?.ephemeral) return toast("Temporary chats can't have goals");
    try {
      // a goal stopped before it was sent reaches nothing in Codex, its settings included
      assertInputCurrent(item);
      // thread/goal/set carries no permission: its turns run on the thread's settings, which resuming reset; the lease
      // is kept meanwhile, or an idle release would unload the thread and reset them again
      this.touch(nid);
      await this.applyPermission(chatId, nid, item.opts, item);
    } catch (e) {
      try {
        assertInputCurrent(item);
      } catch (stop) {
        // the user's Stop, not a failure to tell
        return { started: false, error: messageOf(stop) };
      }
      return toast(`Couldn't set goal: ${messageOf(e)}`);
    }
    const clientId = crypto.randomUUID();
    this.emit({ kind: 'goalStarting', chatId, clientId, objective });
    try {
      this.touch(nid);
      const r = await this.request('thread/goal/set', carryInputGuard(item, { threadId: nid, objective, status: 'active' }));
      this.touch(nid);
      const goal = r?.goal ?? null;
      this.noteGoal(nid, goal);
      this.permissionCaughtUp(chatId, nid);
      this.emit({ kind: 'goal', chatId, goal });
      const meta = this.meta.get(nid) || {};
      // the chat keeps its current name when naming it fails
      if (chatId === nid && !meta.name && this.isolation?.isolated(chatId) !== true)
        this.autoTitle(nid, objective).catch(ignoring('name a new Codex goal chat'));
      return { started: goal?.status === 'active' };
    } catch (e) {
      this.emit({ kind: 'goalFailed', chatId, clientId });
      return toast(`Couldn't set goal: ${goalErrorMessage(e)}`);
    }
  }

  /* -- helper threads ----------------------------------------------- */
  /**
   * Run one turn on a hidden thread and resolve its final text. Its events never reach a window,
   * and it never asks the user anything.
   * @this {CodexAdapter}
   */
  helperTurn(threadId, params, timeoutMs) {
    const done = new Promise((resolve) => {
      let text = '';
      const finish = () => {
        clock.clearTimeout(timer);
        this.hidden.delete(threadId);
        this.drop(threadId, 'helper');
        resolve(text);
      };
      const timer = clock.setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.hidden.set(threadId, {
        on: (m, p) => {
          if (m === 'item/agentMessage/delta') text += p.delta ?? '';
          if (m === 'item/completed' && p.item?.type === 'agentMessage') text = p.item.text ?? text;
          if (m === 'turn/completed') finish();
        },
        done: finish,
      });
    });
    return this.request('turn/start', { threadId, ...params }).then(
      () => done,
      (e) => {
        this.hidden.get(threadId)?.done();
        throw e;
      },
    );
  }

  /**
   * Name a new chat: a provisional title now, then a short generated one from a hidden thread on the same server,
   * started at once (autoTitle.cjs). The chat keeps the provisional title when that fails.
   * @this {CodexAdapter}
   */
  async autoTitle(threadId, prompt) {
    if (this.titling.has(threadId) || !String(prompt).trim()) return;
    const provisional = provisionalTitle(prompt);
    this.titling.set(threadId, provisional);
    this.emit({ kind: 'threadName', chatId: this.chatOf(threadId), name: provisional });
    // a chat kept apart (MoMo's) is not titled by a helper thread that reads its folder: it keeps the provisional title (#2364)
    if (this.isolation.applies({ threadId })) return void this.titling.delete(threadId);
    /** @type {string | null} */
    let helper = null;
    let done = false;
    const release = (id) =>
      this.request('thread/unsubscribe', { threadId: id }).catch((e) => noteIgnored('release the title helper thread', e));
    try {
      await landTitle({
        prompt,
        generate: async () => {
          const r = await this.request(
            'thread/start',
            {
              cwd: this.meta.get(threadId)?.cwd,
              ephemeral: true,
              approvalPolicy: 'never',
              sandbox: 'read-only',
              developerInstructions: 'You write short titles for coding tasks. Reply with the title only.',
            },
            { helper: true },
          );
          // the title stopped waiting (too slow): the helper started late is let go, not left subscribed
          if (done) return void release(r.thread.id);
          helper = r.thread.id;
          return this.helperTurn(
            helper,
            { input: [{ type: 'text', text: titlePrompt(prompt), text_elements: [] }], effort: 'low' },
            TITLE_MS,
          );
        },
        // renamed by the user meanwhile (threadRename lets go of the provisional title): keep their name
        unnamed: () => {
          const cur = this.meta.get(threadId)?.name ?? null;
          return this.titling.has(threadId) && (!cur || cur === provisional);
        },
        // a thread that can't be renamed (read-only) keeps its name: noted, as before
        apply: (name) => this.request('thread/name/set', { threadId, name }).catch((e) => noteIgnored('name a Codex chat', e)),
        what: 'write a title for a Codex chat',
      });
    } finally {
      done = true;
      this.titling.delete(threadId);
      // the helper thread is ephemeral
      if (helper) release(helper);
    }
  }

  /**
   * A handoff note from a Codex thread, written in an ephemeral fork so the original is untouched.
   * @this {CodexAdapter}
   */
  async summarize(threadId, prompt) {
    // the note of an isolated chat is written by a fork that runs under the chat's rule: memory off, strictest sandbox (#2364)
    const isolated = this.isolation.applies({ threadId });
    const f = await this.request('thread/fork', { threadId, ephemeral: true, excludeTurns: true }, { helper: true });
    const fork = f.thread.id;
    if (isolated) this.isolation.helpers.add(fork);
    try {
      const text = await this.helperTurn(
        fork,
        { input: [{ type: 'text', text: prompt, text_elements: [] }], effort: 'low', ...permissionParams('read-only') },
        180_000,
      );
      return text.trim();
    } finally {
      // the fork is ephemeral
      this.isolation.helpers.delete(fork);
      this.request('thread/unsubscribe', { threadId: fork }).catch((error) => noteIgnored('release the handoff fork', error));
    }
  }
}

module.exports = { CodexTurns, goalErrorMessage };
