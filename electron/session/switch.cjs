// A mid-chat harness switch, settled in main (design §05, WP1-5). The window only says what the user
// chose (`pendingSwitch` in the session state) and sends the message; before that message goes out the
// ChatController asks `perform` to close the chat's current segment, open (or resume) the target's
// native session, and write the handoff record from the chat's history, which main reads itself from
// each native session (Claude's transcript, Codex's thread turns) with the translators in shared/.
// Its answer is what the message carries: the record (`prefix`), the divider (`note`), and what to
// send after the message (a goal set again).
const { keptOf, switchedConfig } = require('./keepSelection.cjs');
const { turnFromServer } = require('../../shared/codexTurns.mjs');
const { readChatTurns } = require('../harness/items/acpTranslator.cjs');
const {
  backDivider,
  composeHandoff,
  dividerText,
  estimateTokens,
  goalAgain,
  heldText,
  sliceSegments,
  workspaceText,
} = require('../../shared/handoff.mjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const acpQuirks = require('../harness/quirks/index.cjs');
const { switchAdapter: inPlace, switchLabel } = require('./switchAdapters.cjs');
const { segmentKey } = require('../platform/segmentOwner.cjs');
const { toRendererSegment } = require('../platform/chats.cjs');
const { noteIgnored, messageOf } = require('../ignored.cjs');
const { switchAccount } = require('./switchAccount.cjs');
const { codexRollouts } = require('../harness/codexRollout.cjs');
const { performContinue } = require('./switchContinue.cjs');
const { configuredSwitchModel } = require('../../shared/switchModel.mjs');

/** The most pages of a Codex thread's turns read for a handoff (50 turns a page). */
const MAX_PAGES = 40;

/** Whether a native kind can participate in a stable-chat switch. */
const switchesInPlace = (kind) => !!inPlace(kind);
const NOT_IN_PLACE = 'This harness cannot take over this chat';
/** What a switch that could not settle tells the user to do: the message waits in the queue, and the switch is still chosen. */
const KEPT = 'Your message is kept in the queue: fix that and send it again, or cancel the switch to send it here.';
/** The reason a switch did not settle, then what to do (a reason that ends in a full stop doesn't get a second one). */
const unsettled = (why) => `${/[.!?]$/.test(why) ? why : `${why}.`} ${KEPT}`;

class SwitchRunner {
  /**
   * @param {object} o
   * @param o.chats ChatsStore: the chat's segments are read and written here
   * @param o.ref (chatId) => the chat's NativeRef
   * @param o.invalidate () => void: the controller's segment aliases are stale
   * @param o.claim (key, chatId) => void: the native session `key` (renderer form) is the chat's from now, before its segment is committed
   * @param o.unclaim (key, chatId) => void: drop that claim (the segment is committed, or the switch gave up)
   * @param o.changed (chatId) => void: tell every window the chat's segments changed (chats:changed)
   * @param o.prefs () => the app's prefs (permission, serviceTier, claudeBin)
   * @param o.home the folder a chat without one runs in
   * @param o.emit (event, target) => void: to windows ('codex:item' events: a toast, `switched`)
   * @param o.git - { info(cwd), status(cwd) } as the window's Git panel reads them
   * @param o.codex - { startThread(params, { onThread }), ensureResumed(id), threadTurns(id, page), summarize(id, prompt), cwdOf(id) }
   * @param o.claude - { registerSession(key, info), isFresh(key), cwdOf(ref), accountOf(chatId), messages(sessionId), summarize(sessionId, cwd, prompt, bin, account, chatId) }
   * @param o.permissionParams (mode) => the thread/start permission params
   * @param [o.acpHost] - the ACP host, whose transcripts a basic-harness chat's turns are read from, for the record a new chat started
   *   from it carries
   * @param [o.acpQuirks] - { describe(id) }: a basic harness's name in that record (the quirks files by default)
   * @param [o.accounts] the Codex pool getter and ClaudeTurns (switchAccount.cjs): the chat goes on its account there
   * @param [o.putAccount] ({ chatId, harness, nativeId, account }) => Promise|void: instead of `accounts`; `account` is
   *   the one picked with the switch, null for the chat's own pin there
   * @param [o.held] (chatId) => the targets the chat holds (TargetLeases.held): the handoff record lists them
   * @param [o.segmentEnded] ({ chatId, from, to }) => void: the switch settled; `from` and `to` are the old and new
   *   segment's NativeRef. Retires what the old segment's controllers left in the chat (design: segment end).
   * @param [o.rollouts] - { history(threadId) }: a Codex thread's turns from its rollout file, for while the app-server
   *   is down (electron/harness/codexRollout.cjs by default)
   * @param [o.isolated] (chatId) => boolean: the chat is kept apart from the coding side (MoMo's)
   * @param [o.continues] - { pending(chatId), done(chatId) }: the handoffs of chats that came back to this Mac from another Host
   * @param [o.workspaceOf] (chatId) => string | null: the folder an isolated chat always runs in (MoMo's workspace), whatever
   *   its old session says; null for any other chat
   */
  constructor(o) {
    this.chats = o.chats;
    this.ref = o.ref;
    this.invalidate = o.invalidate;
    this.claim = o.claim;
    this.unclaim = o.unclaim;
    this.changed = o.changed;
    this.prefs = o.prefs;
    this.home = o.home;
    this.emit = o.emit;
    this.git = o.git;
    this.codex = o.codex;
    this.claude = o.claude;
    this.permissionParams = o.permissionParams;
    this.acpHost = o.acpHost ?? null;
    this.acpQuirks = o.acpQuirks ?? acpQuirks;
    this.segmentEnded = o.segmentEnded ?? null;
    this.held = o.held ?? (() => []);
    this.putAccount = o.putAccount ?? (o.accounts ? switchAccount({ chats: o.chats, ...o.accounts, activateSelection: true }) : null);
    this.rollouts = o.rollouts ?? null;
    this.isolated = o.isolated ?? (() => false);
    this.workspaceOf = o.workspaceOf ?? (() => null);
    this.continues = o.continues ?? null;
  }

  /** The continue waiting for the chat's next message (it came back to this Mac from another Host), shaped as the pending switch the controller settles first. */
  pendingContinue(chatId) {
    const c = this.continues?.pending(chatId);
    return c ? { harness: c.harness, continue: c } : null;
  }

  /** A Codex thread's history from its rollout file, or null (no file, or it can't be read). */
  async fromRollout(threadId) {
    try {
      return await (this.rollouts ?? codexRollouts()).history(threadId);
    } catch (error) {
      noteIgnored("read a Codex thread's rollout file for a handoff", error);
      return null;
    }
  }

  toast(level, text, origin) {
    this.emit({ kind: 'toast', level, text }, origin ?? 'any');
  }

  label(kind) {
    return switchLabel(kind, this.acpQuirks);
  }

  /** ACP transcripts are keyed by their complete native key, including the harness id. */
  async acpTurns(seg, cwd, failed) {
    try {
      const key = segmentKey(seg.kind, seg.nativeId);
      return (await readChatTurns(this.acpHost, key, key, { cwd })).turns;
    } catch (error) {
      failed.push({ kind: seg.kind, error });
      return [];
    }
  }

  /* -- history -------------------------------------------------------- */
  /**
   * A Claude session's turns, from its transcript; a session that never ran has none. A transcript that
   * cannot be read adds `{ kind, error }` to `failed` and reads as none.
   */
  async claudeTurns(chatId, nativeId, cwd, failed = []) {
    if (this.claude.isFresh(`claude:${nativeId}`)) return [];
    try {
      return await this.claude.allTurns(nativeId, { chatId, cwd });
    } catch (error) {
      // no transcript: a session that never ran (one made before a restart is no longer known to be fresh)
      if (error?.code === 'ENOENT') return [];
      noteIgnored('read the Claude Code transcript for a handoff', error);
      failed.push({ kind: 'claude', error });
      return [];
    }
  }

  /**
   * A Codex thread's turns, oldest first; when a page cannot be read, its rollout file's turns, else the turns read
   * before it. That failure adds `{ kind, error }` to `failed` when turns were lost for sure: after the first page, or
   * for a thread that `hadTurns`. A first page that fails otherwise may be a thread that never had a message.
   */
  async codexTurns(nativeId, failed = [], hadTurns = false) {
    // threadTurns below fails too if the thread is unusable, and that is reported there
    await this.codex.ensureResumed(nativeId).catch((error) => noteIgnored('resume the Codex thread for a handoff', error));
    let all = [];
    let cursor = null;
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await this.codex.threadTurns(nativeId, { limit: 50, cursor, itemsView: 'full' });
        all = [...(page.data ?? []).map(turnFromServer).reverse(), ...all];
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (error) {
      noteIgnored('read the Codex thread for a handoff', error);
      // the app-server is down (switching away from it must still carry the conversation): its rollout file has it all
      const disk = await this.fromRollout(nativeId);
      if (disk) return disk.turns.map(turnFromServer);
      if (cursor || hadTurns) failed.push({ kind: 'codex', error });
    }
    return all;
  }

  /** Each native session of the chat's segments, as turns, keyed by its id; sessions that could not be read go to `failed`. */
  async history(chatId, segs, cwd, failed = []) {
    const out = new Map();
    for (const seg of segs) {
      const key = segmentKey(seg.kind, seg.nativeId);
      if (out.has(key)) continue;
      // a segment closed with turns in it: its thread had messages
      const hadTurns = segs.some((s) => s.kind === seg.kind && s.nativeId === seg.nativeId && s.count > 0);
      const own = inPlace(seg.kind);
      if (!own) {
        // a session no switch reads (a basic harness never takes part in one): the handoff says it is missing
        failed.push({ kind: seg.kind, error: new Error("this harness's history can't be read for a handoff") });
        out.set(key, []);
        continue;
      }
      out.set(key, await own.turns(this, chatId, seg, cwd, failed, hadTurns));
    }
    return out;
  }

  /**
   * The chat's whole history as turns, oldest first, across its segments, with its segments, its folder and what could not be read (`failed`).
   * @returns {Promise<{ segs: any[], cwd: string, failed: { kind: string, error: unknown }[], turns: any[] }>}
   */
  async chatTurns(chatId, ref) {
    const segs = this.chats.record(chatId).segments.map((x) => ({ ...x }));
    const cwd = await this.folderOf(chatId, ref);
    const failed = [];
    const slices = sliceSegments(segs, await this.history(chatId, segs, cwd, failed), (/** @type {any} */ s) =>
      segmentKey(s.kind, s.nativeId),
    );
    return { segs, cwd, failed, turns: slices.flat() };
  }

  /** The folder the chat's current session runs in: home when its harness doesn't say. */
  async cwdOf(ref) {
    return (await inPlace(ref.kind)?.cwd(this, ref)) || this.home;
  }

  /**
   * The folder the chat's new session runs in and its handoff describes: an isolated chat's is its own workspace (its old
   * session may not say: a Claude Code session no message has started forgets its folder at a restart, and the home folder
   * a switch falls back to is the user's, not MoMo's); any other chat's is the old session's.
   */
  async folderOf(chatId, ref) {
    return this.workspaceOf(chatId) || (await this.cwdOf(ref));
  }

  /* -- the record ----------------------------------------------------- */
  async workspace(cwd) {
    let info = null;
    let status = null;
    try {
      info = await this.git.info(cwd);
      status = await this.git.status(cwd);
    } catch (error) {
      // not a git repo or git missing: describe the folder without git details
      noteIgnored('read Git details for a handoff', error);
    }
    return workspaceText(cwd, info, status);
  }

  /** The source harness writes a note about the conversation in a hidden fork, so the original is untouched. */
  async summarize(chatId, from, ref, cwd) {
    const own = inPlace(from);
    if (!own?.summarize) throw new Error('This harness has no isolated summary operation');
    return own.summarize(this, chatId, ref, cwd);
  }

  /**
   * The <sage-handoff> block for the target. `turns` are the chat's turns before the switch;
   * `since` is the first one the target hasn't seen.
   */
  async handoff({ chatId, mode, since, from, ref, target, cwd, turns, fromModel, holds = true }) {
    const note = mode === 'summary' ? await this.summarize(chatId, from, ref, cwd) : null;
    return composeHandoff({
      from,
      fromLabel: this.label(from),
      fromModel,
      mode,
      turns: turns.slice(since),
      since,
      targetModel: target.model,
      note,
      workspace: await this.workspace(cwd),
      // the tabs and locks are the chat's, not the segment's: the new harness is told which it holds (a new chat holds none)
      held: holds ? heldText(this.held(chatId), target.harness) : '',
    });
  }

  /**
   * The record a new chat started from this one carries (COPY.switchSheet.newChatWithSummary): the text, or throws.
   * A harness that hands a chat over in place writes a note about it; a basic harness can't write one without
   * adding to the conversation, so its chat is handed over as its transcript instead (`targetLabel` names the new
   * chat's harness, which may be any harness).
   */
  async summaryNote(chatId, targetLabel) {
    const ref = this.ref(chatId);
    if (!inPlace(ref.kind)?.summarize) return this.basicRecord(ref);
    const from = ref.kind;
    const cwd = await this.folderOf(chatId, ref);
    const rec = this.chats.record(chatId);
    const fromModel = rec.segments.at(-1)?.model;
    return this.handoff({
      chatId,
      mode: 'summary',
      since: 0,
      from,
      ref,
      target: { harness: from, model: '', modelLabel: targetLabel, mode: 'summary' },
      cwd,
      turns: [],
      fromModel,
      // the tabs and locks stay with the chat they were taken for
      holds: false,
    });
  }

  /** A basic-harness chat's handoff record: its conversation from its transcript, in the folder its session ran in. */
  async basicRecord(ref) {
    const key = ref.key ?? `${ref.kind}:${ref.id}`;
    // a turn still running there is handed over as far as it got, not as cut off
    const { turns, cwd } = this.acpHost
      ? await readChatTurns(this.acpHost, key, key, { cwd: this.home, find: true, live: true })
      : { turns: [], cwd: this.home };
    return composeHandoff({
      from: ref.kind,
      fromLabel: this.acpQuirks.describe(parseKind(ref.kind)?.basic)?.label ?? ref.kind,
      fromModel: null,
      mode: 'auto',
      turns,
      since: 0,
      targetModel: '',
      note: null,
      // the tabs and locks stay with the chat they were taken for: the new chat holds none
      workspace: await this.workspace(cwd),
    });
  }

  /* -- switching ------------------------------------------------------ */
  /**
   * A new native session for the target; the first message starts it. It is claimed for the chat before it
   * can send anything (a Codex thread: as thread/start answers, before its lease and notifications), and
   * `claimed` lists the keys so perform() drops the claims once the segment is committed or the switch fails.
   */
  async startNative(chatId, harness, cwd, model, claimed) {
    const claim = (key) => (claimed.push(key), this.claim(key, chatId));
    const own = inPlace(harness);
    if (!own) throw new Error(NOT_IN_PLACE);
    return own.start(this, cwd, configuredSwitchModel(harness, model), claim, chatId, harness);
  }

  /**
   * Settle the chat's pending switch `ps`; `check` fences automatic input ownership after waits and before commit.
   * @returns {Promise<{ ready: boolean, error?: string, prefix?: string, note?: object, after?: { text: string, opts: object }[] }>} `ready` false: no
   *   switch, and `error` says why and what to do
   */
  async perform(chatId, ps, origin = null, check = () => undefined) {
    /** @type {string[]} native sessions claimed for the chat while it switches */
    const claimed = [];
    try {
      return await this.settle(chatId, ps, origin, claimed, check);
    } finally {
      // committed: the chat's segments name them now; failed: they are no chat's
      for (const key of claimed) this.unclaim(key, chatId);
    }
  }

  /** perform(), with the native sessions it claims added to `claimed`. */
  async settle(chatId, ps, origin, claimed, check) {
    check();
    const ref = this.ref(chatId);
    if (!ps) return { ready: true };
    if (ps.continue) {
      const out = await performContinue(this, chatId, ps.continue, origin, claimed, check);
      if (out.ready) this.continues?.done(chatId);
      return out;
    }
    const from = ref.kind;
    if (ps.harness === from) return { ready: true };
    const own = inPlace(ps.harness);
    // Unknown sources or targets keep the user's message queued.
    if (!inPlace(from) || !own) {
      this.toast('error', NOT_IN_PLACE, origin);
      return { ready: false, error: unsettled(NOT_IN_PLACE) };
    }

    // The controller detached this choice; refine it in place so failed retries and its producer keep the same snapshot.
    ps.model = ps.model === null ? null : configuredSwitchModel(ps.harness, ps.model, this.prefs());
    const { segs, cwd, failed, turns } = await this.chatTurns(chatId, ref);
    check();
    // the handoff goes on with what could be read (switching away from a harness that is down must work),
    // and the user is told it is missing part of the conversation
    if (failed.length) {
      const sources = [...new Set(failed.map((f) => this.label(f.kind)))].join(' and ');
      const why = messageOf(failed[0].error);
      this.toast(
        'error',
        `Couldn't read the earlier conversation from ${sources} (${why}); the handoff includes only what could be read`,
        origin,
      );
    }
    const n = turns.length;
    const cur = segs[segs.length - 1];
    cur.count = n - cur.start;

    // returning to a harness this chat used before: resume that session and hand over only what it missed
    const prev = [...segs].reverse().find((x) => x.kind === ps.harness);
    let mode = ps.mode;
    let since = 0;
    let nativeId;
    let fresh = false;
    let prepared;
    const claim = (key) => (claimed.push(key), this.claim(key, chatId));
    try {
      if (prev) {
        prepared = own.resume ? await own.resume(this, prev, cwd, claim, chatId) : { nativeId: prev.nativeId, fresh: false };
        ({ nativeId, fresh } = prepared);
        if (!fresh && !prepared.needsContext) {
          since = prev.start + (prev.count ?? 0);
          if (ps.mode === 'auto') mode = 'delta';
        }
      } else {
        prepared = await this.startNative(chatId, ps.harness, cwd, ps.model, claimed);
        ({ nativeId, fresh } = prepared);
      }
    } catch (e) {
      check();
      const why = `Couldn't start ${this.label(ps.harness)}: ${messageOf(e)}`;
      this.toast('error', why, origin);
      return { ready: false, error: unsettled(why) };
    }

    check();
    if (mode === 'summary') this.toast('info', `${this.label(from)} is writing a handoff note…`, origin);
    const input = { chatId, since, from, ref, target: ps, cwd, turns, fromModel: cur.model };
    let text;
    try {
      text = await this.handoff({ ...input, mode });
    } catch (e) {
      check();
      this.toast('error', `Handoff note failed (${e?.message ?? e}); continuing with the workspace only`, origin);
      mode = 'workspace';
      text = await this.handoff({ ...input, mode });
    }
    check();
    const tokens = estimateTokens(text);
    const caught = prev ? n - since : undefined;
    segs.push({
      kind: ps.harness,
      nativeId,
      instance: null,
      provider: null,
      model: ps.model,
      start: n,
      count: null,
      handoff: { mode, tokens, text, ...(caught != null ? { caught } : {}) },
    });
    // Preserve edits made during the handoff; the old segment keeps its effort and tier for a switch back.
    const now = this.chats.record(chatId);
    cur.kept = keptOf(now.meta?.config);
    const config = switchedConfig(now.meta?.config, ps.model, prev?.kept, ps.effort);
    // An adapter prepares its account choice before the commit and undoes it if the write fails: a retry still has the previous segment.
    let automatic;
    if (ps.automaticAccount === true) {
      try {
        if (!this.putAccount?.prepareAutomatic) throw new Error('the account pool is unavailable');
        automatic = this.putAccount.prepareAutomatic(ps.harness, nativeId);
      } catch (e) {
        return { ready: false, error: unsettled(`Couldn't select Automatic (${messageOf(e)})`) };
      }
    }
    const meta = { ...now.meta, config, ...automatic?.meta };
    // undo the account step after a failed write; a failed undo is said instead of the write's own error
    const rollback = (why) => {
      try {
        automatic?.undo?.();
      } catch (e) {
        return { ready: false, error: unsettled(`Couldn't restore the previous account (${messageOf(e)})`) };
      }
      return { ready: false, error: unsettled(why) };
    };
    let saved;
    try {
      saved = this.chats.commit({ ...now, meta, segments: segs });
    } catch (e) {
      return rollback(`The chat could not save its new session (${messageOf(e)})`);
    }
    if (!saved) return rollback('The chat could not save its new session');
    this.invalidate();
    // the chat goes on the account picked with the switch, or its own pin there, before its first turn starts
    try {
      if (automatic) automatic.after?.(chatId);
      else await this.putAccount?.({ chatId, harness: ps.harness, nativeId, account: typeof ps.account === 'string' ? ps.account : null });
    } catch (e) {
      this.toast(
        'error',
        `Couldn't put this chat on that ${this.label(ps.harness)} account (${messageOf(e)}); it uses the one in use`,
        origin,
      );
    }
    // the switch is settled whatever a segment-end handler does
    try {
      this.segmentEnded?.({ chatId, from: ref, to: this.ref(chatId) });
    } catch (error) {
      noteIgnored("retire a chat's earlier segment after a switch", error);
    }
    // every window learns the chat's new segments, the way it learns a change another window made
    this.changed(chatId);
    own.activate?.(this, prepared);
    // the window shows the chat on the target's model, and forgets the previous harness's per-chat settings
    this.emit({
      kind: 'switched',
      chatId,
      harness: ps.harness,
      key: toRendererSegment({ kind: ps.harness, nativeId }).nativeId,
      model: ps.model,
      fresh,
      start: n,
    });
    const label = prev
      ? backDivider(this.label(ps.harness), n - since, this.label(from))
      : dividerText(from, ps.harness, ps.modelLabel, mode, tokens, this.label(from), this.label(ps.harness));
    const note = { kind: 'switch', text: label, handoff: text };
    // a goal the user chose to continue is set again on the new segment once the message's turn is over
    const after = ps.goal && inPlace(ps.harness)?.summarize ? [goalAgain(ps.harness, ps.goal)] : undefined;
    return { ready: true, prefix: text, note, ...(after ? { after } : {}) };
  }
}

module.exports = { SwitchRunner, switchesInPlace };
