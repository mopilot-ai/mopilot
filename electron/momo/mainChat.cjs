// MoMo's main chat (#2139): one long-lived chat main owns, made with ChatStarter in MoMo's own workspace (no project) and
// tagged meta.momo = 'main' (no list of chats shows it), on the harness, account and model of MoMo's brain (prefs
// momo.brain.main; until one is picked, Claude Code on Opus with the first Claude login, else the first harness that can
// run). Kept across restarts in <dir>/state.json and replaced when archived or gone. A brain change reaches the chat
// through its own harness switch (a pending switch its next message settles, session/switch.cjs) and account pins; a
// harness that can't take over a chat in place gets a new main chat. Everything but isMomoChat refuses while MoMo isn't
// allowed for the account. Main writes the chats' meta itself, so it tells every window (`changed`).
const path = require('node:path');
const { writeAtomic, readStateFile } = require('../platform/fsutil.cjs');
const { mkdirPrivate } = require('../platform/privateFiles.cjs');
const { messageOf } = require('../ignored.cjs');
const { momoResetting, momoWorkspace } = require('./stores.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { pinModel, switchModel, brainOf, PICKS } = require('./brainModel.cjs');
const { askedEffort, brainEffort } = require('./brainEffort.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { HARNESS_LABEL } = require('../../shared/handoff.mjs');
const { familyOf, byFamily } = require('../session/contract/route.cjs');
const { switchAccount } = require('../session/switchAccount.cjs');
const { switchesInPlace } = require('../session/switch.cjs');
const acpQuirks = require('../harness/quirks/index.cjs');
const { assertCleanWorkspace, assertConfinable } = require('./apart.cjs');

/** MoMo's brain before the user picks one: Claude Code on Opus (with the first Claude login), when it can run. */
const DEFAULT_BRAIN = { harness: 'claude', model: 'opus', modelLabel: 'Opus', effort: null };

/** An error with a code the window can tell apart (the IPC passes both on). */
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
const notAllowed = () => failure('not_allowed', 'MoMo is not available for this account.');

/**
 * How each family starts MoMo's chat (ChatStarter), tagged before any window hears of it.
 * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (s: any, cwd: string, basic: string | null, meta: object) => Promise<string> | string>}
 */
const START = {
  // its thread starts without Codex's own tools (harness/codexIsolation.cjs)
  codex: (s, cwd, _basic, meta) => s.startCodex(cwd, null, { meta, isolated: true }),
  claude: (s, cwd, _basic, meta) => s.startClaude(cwd, null, { meta }),
  acp: (s, cwd, basic, meta) => s.startAcp(basic, cwd, null, { meta }),
};

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * @typedef {import('./brainModel.cjs').Brain} Brain
 * @typedef {{ brain: Brain, chatId: string | null, applied: 'saved' | 'now' | 'nextMessage' | 'newChat', previous?: string,
 *   warning: string | null }} BrainChange what a brain change did: saved only (no main chat yet), applied now, with the
 *   chat's next message (a switch in place), or a new main chat (`previous` is the one it replaced)
 */

/** A harness's name for the user: a basic one by the name its quirks give it, else its id. */
function labelOf(kind) {
  const basic = parseKind(kind)?.basic;
  return basic ? (acpQuirks.describe(basic)?.label ?? basic) : HARNESS_LABEL[familyOf(kind)];
}

class MomoMainChat {
  /** @param {Parameters<typeof createMomoMainChat>[0]} o */
  constructor(o) {
    this.o = o;
    this.file = path.join(o.dir, 'state.json');
    this.workspace = momoWorkspace(o.dir);
    this.putAccount = switchAccount({ chats: o.chats, codex: o.accounts.codex, claude: o.accounts.claude });
    /** The last operation's settling: the next one waits for it, so no two operations on the main chat overlap. */
    this.tail = Promise.resolve();
    /** ensureMainChat calls while one runs get its answer: they never make a second chat. */
    this.ensuring = null;
    /** state.json's main chat id, read once; undefined until then */
    this.savedId = undefined;
  }

  refuse() {
    if (!this.o.allowed()) throw notAllowed();
  }

  /** No chat of MoMo's is made while Reset deletes them (#2291): it would outlive the reset. */
  refuseWhileResetting() {
    if (momoResetting()) throw failure('resetting', 'MoMo is being reset; try again once it is done.');
  }

  /**
   * `fn` after every operation before it has settled, whatever its outcome (its caller has that).
   * @template T
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  serial(fn) {
    const before = this.tail;
    /** @type {(value?: unknown) => void} */
    let release = /** @type {any} */ (null);
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    return before.then(fn).finally(release);
  }

  /** Every window reads the chat's meta again (chats:changed): main wrote it. */
  changed(chatId) {
    this.o.changed(chatId);
  }

  /** Mark a chat MoMo's previous one (hidden, never the main chat again), and tell the windows. */
  retire(chatId) {
    if (this.o.chats.patchMeta(chatId, { momo: 'previous' })) this.changed(chatId);
  }

  /* -- the brain ----------------------------------------------------- */
  /** The saved brain, or null before one is picked. */
  getBrain() {
    this.refuse();
    return this.brain();
  }

  brain() {
    return brainOf(this.o.prefs.get()?.momo?.brain?.main);
  }

  saveBrain(brain) {
    const momo = this.o.prefs.get()?.momo;
    const prev = isJsonRecord(momo) ? momo : {};
    const set = { momo: { ...prev, brain: { ...(isJsonRecord(prev.brain) ? prev.brain : {}), main: brain } } };
    if (this.o.prefs.patch(set) === false) throw failure('save_failed', "Couldn't save MoMo's brain.");
    // every window's chip reads it again
    this.o.brainChanged?.(brainOf(brain));
  }

  /**
   * MoMo's brain before the user picks one: Claude Code on Opus with the first Claude login when Claude Code can run,
   * else the first harness that can (its own default model and account). Null when none can.
   * @returns {Promise<Brain | null>}
   */
  async defaultBrain() {
    if (await this.o.usable(DEFAULT_BRAIN.harness)) return { ...DEFAULT_BRAIN, account: this.o.accounts.claudeLogins()[0] ?? null };
    for (const kind of this.o.kinds()) if (await this.o.usable(kind)) return brainOf({ harness: kind });
    return null;
  }

  /* -- the chat ------------------------------------------------------ */
  isMomoChat(chatId) {
    return isMomoMeta(this.o.chats.records.get(chatId)?.meta);
  }

  /** The main chat's id, or null before there is one. */
  mainChatId() {
    this.refuse();
    return this.current();
  }

  /** A chat that can go on being MoMo's main chat: still there, not archived, tagged MoMo's main. */
  usable(id) {
    if (typeof id !== 'string' || !id || this.o.chats.isDeleted?.(id)) return false;
    const meta = this.o.chats.records.get(id)?.meta;
    return isMomoMeta(meta) && meta.momo === 'main' && meta.archived == null;
  }

  /**
   * The main chat: the one state.json names while it can go on, else the newest chat still tagged main (state.json
   * missing or unreadable); null when there is none. There is one main chat: a saved one that can't go on (archived)
   * and every other chat still tagged main (one a start left behind) are retagged 'previous'.
   */
  current() {
    if (this.savedId === undefined) this.savedId = readStateFile(this.file, "MoMo's state")?.mainChatId ?? null;
    const saved = this.savedId;
    if (typeof saved === 'string' && !this.usable(saved) && this.isMomoChat(saved)) this.retire(saved);
    const mains = [...this.o.chats.records]
      .filter(([id]) => this.usable(id))
      // every saved record has its time (ChatsStore.commit)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .map(([id]) => id);
    const main = this.usable(saved) ? saved : (mains[0] ?? null);
    for (const other of mains) if (other !== main) this.retire(other);
    if (main && main !== saved) this.save(main);
    return main;
  }

  /**
   * MoMo's earlier main chats, the ones a brain change (or an archive) replaced, newest first: each with the harness it
   * last ran on, by name, and when it was last written, so the user can read the conversation again.
   * @returns {{ chatId: string, harness: string, at: number }[]}
   */
  previousChats() {
    this.refuse();
    return [...this.o.chats.records]
      .filter(([id, r]) => isMomoMeta(r.meta) && r.meta.momo === 'previous' && !this.o.chats.isDeleted(id))
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .map(([chatId, r]) => ({ chatId, harness: labelOf(r.segments.at(-1).kind), at: r.updatedAt }));
  }

  /** MoMo is working: a turn runs on the chat, or waits for the user. */
  working(chatId) {
    const s = this.o.controller.state.get(chatId);
    return s.turn === 'running' || s.turn === 'awaitingUser';
  }

  /** Working or with messages waiting: not replaced under them. A message that didn't start with nothing running isn't work (#2276). */
  busy(chatId) {
    return this.working(chatId) || this.o.controller.state.get(chatId).queue.length > 0;
  }

  save(chatId) {
    writeAtomic(this.file, JSON.stringify({ mainChatId: chatId }, null, 2));
    this.savedId = chatId;
  }

  /**
   * Make sure the main chat exists: concurrent calls make one chat. Resolves its id, and a warning when part of the
   * brain couldn't be applied (the user is told; the chat goes on). Before a brain is picked, the default becomes it.
   * @returns {Promise<{ chatId: string, warning: string | null }>}
   */
  async ensureMainChat() {
    this.refuse();
    this.refuseWhileResetting();
    this.ensuring ??= this.serial(() => this.ensure()).finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  async ensure() {
    // MoMo may have been turned off while this waited for the operation before it
    this.refuse();
    const id = this.current();
    if (id) return this.keep(id);
    return this.create(await this.brainOrDefault());
  }

  /** The saved brain; before one is picked, the default becomes it. */
  async brainOrDefault() {
    let brain = this.brain();
    if (!brain) {
      brain = await this.defaultBrain();
      this.refuse();
      if (!brain) throw failure('no_harness', 'No harness can run MoMo now: install one or sign in.');
      this.saveBrain(brain);
    }
    return brain;
  }

  /** Whether the harness holds no session for the chat; a probe that fails says nothing, and the send shows what is wrong. */
  async gone(id) {
    try {
      return await this.o.controller.sessionGone(id);
    } catch {
      return false;
    }
  }

  /** The main chat brought to the brain saved now (a restart forgot its pending switch; prefs changed meanwhile). */
  async keep(id) {
    // a session the harness no longer holds (a restart forgot one no message ever started, #2502) is never resumed
    if (!this.busy(id) && (await this.gone(id))) return this.restart(id);
    const brain = this.brain();
    if (!brain) return { chatId: id, warning: null };
    // on the brain's harness the chat keeps its account (one picked in the chat's own menu stays); its model is the
    // brain's (a chat made before the model was kept in its file gets it now)
    if (this.planFor(id, brain) === 'now') {
      if (pinModel(this.o.chats, id, brain)) this.changed(id);
      return { chatId: id, warning: null };
    }
    const r = this.reconcile(id, brain);
    if (r.applied !== 'newChat') return { chatId: id, warning: r.warning };
    const until = this.working(id) ? 'its turn ends' : 'its waiting message is sent or removed';
    if (this.busy(id)) return { chatId: id, warning: `MoMo moves to ${labelOf(brain.harness)} once ${until}.` };
    return this.replace(id, brain);
  }

  /**
   * The main chat's session is gone: a new main chat on the brain (the default one when none is saved), the old one kept
   * as 'previous', and the user told. When no new chat can start, the old one stays with the reason, and the next open tries again.
   */
  async restart(id) {
    try {
      const made = await this.replace(id, await this.brainOrDefault());
      return {
        ...made,
        warning: [made.warning, 'MoMo started a new conversation: its last one could not be reopened.'].filter(Boolean).join(' '),
      };
    } catch (e) {
      if (e?.code === 'not_allowed') throw e;
      return { chatId: id, warning: `Couldn't start a new MoMo conversation (${messageOf(e)}).` };
    }
  }

  /** A new main chat on the brain; the old one stays MoMo's (hidden) as 'previous'. */
  async replace(oldId, brain) {
    const made = await this.create(brain);
    this.retire(oldId);
    return { ...made, previous: oldId };
  }

  /** A new main chat on the brain, in MoMo's workspace; state.json names it from now. */
  async create(brain) {
    // owner-only, like everything else in MoMo's folder: what the harness writes there is the user's
    this.needsChatgpt(brain);
    mkdirPrivate(this.workspace);
    assertConfinable(brain.harness, labelOf(brain.harness), this.o.env?.());
    assertCleanWorkspace(this.workspace);
    const start = byFamily(START, brain.harness);
    const chatId = await start(this.o.chatStarter, this.workspace, parseKind(brain.harness)?.basic ?? null, { momo: 'main' });
    try {
      // MoMo turned off while the harness started: the chat is never MoMo's main one
      this.refuse();
      this.save(chatId);
    } catch (e) {
      this.retire(chatId);
      throw e;
    }
    const warning = this.applyPicks(chatId, brain);
    this.changed(chatId);
    return { chatId, warning };
  }

  /**
   * A fresh MoMo background chat (a routine's run) on `brain`, in MoMo's workspace, tagged `tag` before
   * any window hears of it, then on the brain's account and model. Refused while MoMo isn't allowed.
   * @param {unknown} brain @param {{ momo: string } & Record<string, unknown>} tag
   * @returns {Promise<string>} the chat's id
   */
  async startBackground(brain, tag) {
    this.refuse();
    this.refuseWhileResetting();
    const asked = brainOf(brain);
    if (!asked) throw failure('no_harness', 'No harness can run MoMo now: install one or sign in.');
    // its own effort (the background passes ask for a low one) where its model offers it
    const b = { ...asked, effort: await brainEffort(asked, this.o.efforts) };
    this.needsChatgpt(b);
    mkdirPrivate(this.workspace);
    assertConfinable(b.harness, labelOf(b.harness), this.o.env?.());
    assertCleanWorkspace(this.workspace);
    const chatId = await byFamily(START, b.harness)(this.o.chatStarter, this.workspace, parseKind(b.harness)?.basic ?? null, tag);
    this.applyPicks(chatId, b);
    this.changed(chatId);
    return chatId;
  }

  /**
   * Put the chat, already on the brain's harness, on its account and model: the account through the harness's own pin
   * (switchAccount.cjs), the model as the chat's own pick. A warning when the account can't be used.
   */
  applyPicks(chatId, brain) {
    const picks = byFamily(PICKS, brain.harness);
    if (!picks) return null;
    /** @type {string | null} */
    let warning = null;
    if (brain.account) {
      const ref = this.o.controller.ref(chatId);
      try {
        this.putAccount({ chatId, harness: familyOf(ref.kind), nativeId: ref.id, account: brain.account });
      } catch (e) {
        warning = `Couldn't put MoMo on that ${labelOf(brain.harness)} account (${messageOf(e)}); it uses the one in use.`;
      }
    }
    pinModel(this.o.chats, chatId, brain);
    if (brain.model) picks.model(this.o, chatId, brain.model);
    return warning;
  }

  /** How a brain reaches the chat: now (same harness), with its next message (a switch in place), or a new chat. */
  planFor(chatId, brain) {
    const kind = this.o.controller.ref(chatId).kind;
    if (kind === brain.harness) return 'now';
    return switchesInPlace(kind) && switchesInPlace(brain.harness) ? 'nextMessage' : 'newChat';
  }

  /** A switch's model: the brain's, its harness default, or empty for native settings; null when a required model is unknown. */
  switchModel(brain) {
    return switchModel(brain, byFamily(PICKS, brain.harness), this.o.prefs.get());
  }

  /**
   * Bring the chat to the brain where it can stay the same chat: its picks now, or a pending switch its next message
   * settles (SwitchRunner.perform puts it on the brain's account there).
   * @returns {{ applied: 'now' | 'nextMessage' | 'newChat', warning: string | null }}
   */
  reconcile(chatId, brain) {
    const applied = this.planFor(chatId, brain);
    const state = this.o.controller.state;
    if (applied === 'now') {
      // a switch chosen for an earlier brain is no longer wanted
      if (state.get(chatId).pendingSwitch) state.patch(chatId, { pendingSwitch: null });
      // during a turn only the model goes on (setBrain refuses a new account then): the login isn't pinned again
      const warning = this.applyPicks(chatId, this.working(chatId) ? { ...brain, account: null } : brain);
      this.changed(chatId);
      return { applied, warning };
    }
    if (applied === 'nextMessage') {
      const model = this.switchModel(brain);
      if (model === null) return { applied, warning: `Pick a model for MoMo on ${labelOf(brain.harness)}.` };
      // the model its Claude Code turns run on once the switch lands (none off Claude Code, #2304)
      if (pinModel(this.o.chats, chatId, { harness: brain.harness, model, effort: brain.effort })) this.changed(chatId);
      const s = state.get(chatId);
      const ps = s.pendingSwitch;
      // the switch already chosen for this brain stays as it is (with what the user chose for its goal)
      if (ps?.harness !== brain.harness || ps.model !== model || (ps.account ?? null) !== brain.account) {
        // an unfinished goal goes on after the switch, as the switch sheet offers
        const goal = s.goal && s.goal.status !== 'complete' ? s.goal.objective : null;
        state.patch(chatId, {
          pendingSwitch: {
            harness: brain.harness,
            model,
            modelLabel: brain.modelLabel ?? model,
            mode: 'auto',
            account: brain.account,
            goal,
          },
        });
      }
    }
    return { applied, warning: null };
  }

  /**
   * Change the brain: saved, then brought to the main chat (when there is one).
   * @returns {Promise<BrainChange>}
   */
  async setBrain(input) {
    this.refuse();
    const brain = brainOf(input);
    if (!brain) throw failure('invalid_brain', 'Pick a harness for MoMo.');
    // a change that names no effort keeps the one MoMo has (changeBrain checks it on the new model)
    return this.serial(() => this.changeBrain({ ...brain, effort: askedEffort(input, this.brain()) }));
  }

  /**
   * A model picked in a MoMo chat's own composer (#2304): for the main chat it is the brain's model (the brain chip shows
   * it); another MoMo chat (a routine's run) keeps it as its own. Only a chat on Claude Code has one.
   * In turn with brain changes, so it never undoes one queued before it.
   * @returns {Promise<{ chatId: string, model: string, warning: string | null }>}
   */
  async setChatModel(chatId, model, modelLabel = null) {
    this.refuse();
    const name = str(model);
    if (!this.isMomoChat(chatId) || !name) throw failure('invalid_model', 'Pick a model for MoMo.');
    return this.serial(async () => {
      const kind = this.o.controller.ref(chatId).kind;
      if (familyOf(kind) !== 'claude') throw failure('invalid_model', `MoMo's model is picked with its brain on ${labelOf(kind)}.`);
      const brain = this.brain();
      if (chatId === this.current() && brain?.harness === kind) {
        const r = await this.changeBrain({ ...brain, model: name, modelLabel: str(modelLabel) ?? name });
        return { chatId, model: name, warning: r.warning };
      }
      this.applyPicks(chatId, { harness: kind, account: null, model: name, modelLabel: null });
      this.changed(chatId);
      return { chatId, model: name, warning: null };
    });
  }

  /**
   * An account the brain names must be one the harness has, in the same billing lane as the one the brain had there (a
   * chat moves between subscriptions, never between a subscription and pay-per-use, as the account picker keeps it).
   */
  checkAccount(brain, before) {
    if (!brain.account) return;
    const lane = this.o.accounts.laneOf(brain.harness, brain.account);
    if (lane == null) throw failure('unknown_account', `That account isn't signed in on ${labelOf(brain.harness)}.`);
    const was = before?.harness === brain.harness && before.account ? this.o.accounts.laneOf(before.harness, before.account) : null;
    if (was != null && was !== lane)
      throw failure('other_lane', `MoMo stays on the same kind of ${labelOf(brain.harness)} plan: pick an account like the one it has.`);
  }

  /** MoMo's Codex app-server signs in only with a ChatGPT login (#2308): a Codex brain on an API key, named or in use, never starts. */
  needsChatgpt(brain) {
    if (familyOf(brain.harness) !== 'codex') return;
    const account = brain.account ?? this.o.accounts.codex()?.active?.()?.id ?? null;
    if (account && this.o.accounts.laneOf('codex', account) === 'apiKey')
      throw failure('unsupported_account', 'MoMo needs a ChatGPT sign-in on Codex');
  }

  /** @returns {Promise<BrainChange>} */
  async changeBrain(asked) {
    this.refuse();
    const brain = { ...asked, effort: await brainEffort(asked, this.o.efforts) };
    assertConfinable(brain.harness, labelOf(brain.harness), this.o.env?.());
    assertCleanWorkspace(this.workspace);
    // a harness that can't run now (not installed, signed out, turned off, not admitted) never becomes the brain
    if (!(await this.o.usable(brain.harness)))
      throw failure('unavailable', `${labelOf(brain.harness)} isn't available now: it is not installed, not signed in, or turned off.`);
    this.refuse();
    const before = this.brain();
    this.checkAccount(brain, before);
    this.needsChatgpt(brain);
    const id = this.current();
    if (!id) {
      this.saveBrain(brain);
      return { brain, chatId: null, applied: 'saved', warning: null };
    }
    const plan = this.planFor(id, brain);
    if (plan === 'nextMessage' && this.switchModel(brain) === null)
      throw failure('no_model', `Pick a model for MoMo on ${labelOf(brain.harness)}.`);
    // while a turn runs only the model may change, and only on a chat already on the brain's harness: the account, the
    // harness and a switch still settling (the chat not yet on the saved brain's harness) wait for the turn to end
    const settled = before?.harness === this.o.controller.ref(id).kind;
    if (this.working(id) && !(plan === 'now' && settled && brain.account === /** @type {Brain} */ (before).account))
      throw failure('busy', `MoMo is working: change its brain when the turn ends.`);
    if (plan === 'newChat' && this.busy(id))
      throw failure('waiting', 'A message is waiting for MoMo: send or remove it, then change its brain.');
    if (plan !== 'newChat') {
      this.saveBrain(brain);
      const r = this.reconcile(id, brain);
      return { brain, chatId: id, applied: r.applied, warning: r.warning };
    }
    this.saveBrain(brain);
    try {
      const made = await this.replace(id, brain);
      return { brain, chatId: made.chatId, applied: 'newChat', previous: id, warning: made.warning };
    } catch (e) {
      // the chat stays where it was, and so does the brain it runs on
      this.saveBrain(before);
      throw e;
    }
  }
}

/**
 * @param {object} o
 * @param {string} o.dir MoMo's folder (state.json, workspace/)
 * @param {InstanceType<typeof import('../platform/chatStart.cjs').ChatStarter>} o.chatStarter how main makes a chat with no window
 * @param {{ ref: (chatId: string) => { kind: string, id: string }, sessionGone: (chatId: string) => Promise<boolean>, state: { get: (chatId: string) => any, patch: (chatId: string, patch: object) => void } }} o.controller
 *   the ChatController: the chat's harness now, its session state, and whether the harness still holds its session
 * @param {any} o.chats ChatsStore: records, record(), patchMeta(), isDeleted()
 * @param {{ get: () => any, patch: (set: object) => unknown }} o.prefs the app's prefs (patch returns false when not saved)
 * @param {{ codex: () => any, claude: any, claudeLogins: () => string[], laneOf: (harness: string, account: string) => string | null }} o.accounts
 *   the Codex account pool getter and ClaudeTurns (switchAccount.cjs), the Claude logins in the order Settings lists them,
 *   and an account's billing lane on a harness ('subscription', 'api', …; null: the harness has no such account)
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account
 * @param {(kind: string) => Promise<boolean>} o.usable the harness can run now: installed, signed in, not turned off, admitted
 * @param {() => string[]} o.kinds the harnesses in the order the app offers them (first tier, then each admitted basic one)
 * @param {(chatId: string) => void} o.changed every window reads the chat again (chats:changed): main changed its meta
 * @param {(brain: Brain | null) => void} [o.brainChanged] every window learns MoMo's brain changed (its chip reads it again)
 * @param {() => Record<string, string | undefined>} [o.env] the login shell's environment, which a harness reads its setup from
 * @param {import('./brainEffort.cjs').EffortSources} [o.efforts] the harnesses' model lists, which a brain's effort is checked against
 */
function createMomoMainChat(o) {
  return new MomoMainChat(o);
}

module.exports = { createMomoMainChat, MomoMainChat, brainOf, notAllowed, failure, labelOf, START, PICKS, DEFAULT_BRAIN };
