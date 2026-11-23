// Making a chat in main with no window: on Codex, Claude Code or a basic harness, in a folder or a fresh managed
// worktree, as a new conversation or a fork of another. Scheduled runs (automationRun.cjs) and chats another chat
// starts (session/orchestration) both come here, and open windows are told of the chat so their sidebar lists it.
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveEnvironment } = require('./environmentSource.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * The setup script of a project's environment for this platform, or '': environment.toml's, else Conductor's
 * (environmentSource.cjs). An environment.toml that is there but can't be read throws, as it always has; Conductor
 * config that can't be read never fails a start: it is reported through `warn` and the start goes on without it.
 * @param {string} repo
 * @param {string} [platform]
 * @param {(context: string, error: unknown) => void} [warn]
 */
function setupScriptOf(repo, platform = process.platform, warn = noteIgnored) {
  const resolved = resolveEnvironment(repo, platform);
  if (resolved.error !== null) throw new Error(resolved.error);
  if (resolved.notice) warn("read the project's Conductor config for its setup script", new Error(resolved.notice));
  return resolved.setup;
}

class ChatStarter {
  /**
   * @param {object} o
   * @param o.prefs () => the app's prefs
   * @param o.codexThread ({cwd, isolated}) => Promise<thread>: a new Codex thread, held by Sage (CodexAdapter.startThread);
   *   `isolated`: a chat kept apart from the coding side (MoMo's), whose thread starts without Codex's own tools
   * @param [o.codexFork] (params) => Promise<thread>: a fork of a Codex thread (CodexAdapter.fork, thread/fork)
   * @param o.claudeSession (key, {cwd, forkFrom?}) => void: a new Claude session the first message starts (ClaudeAdapter.registerSession)
   * @param [o.claudeFork] (sessionId, cwd) => Promise<{sessionId}>: a durable copy of a Claude conversation in its new folder
   * @param [o.claudeOwn] (chatId, settings) => void: apply the saved chat selection before its first turn
   * @param o.acpSession (key, {cwd}) => void: a new basic-tier session the first message starts (AcpTurns.registerSession)
   * @param o.chats ChatsStore (patchMeta)
   * @param o.worktree (cwd, opts) => Promise<{ok, path, worktree, repo, error}>: platform/git.cjs worktreeAdd
   * @param o.script (cwd, script) => Promise<{exitCode, output}>: platform/git.cjs runScript
   * @param [o.discardWorktree] (worktree) => Promise<{discarded: boolean, reason?: string}>: remove a clean, just-prepared worktree without force
   * @param o.started (event) => void: a chat was made, for the windows that are open (`history`: it starts from a
   *   conversation already on disk, which a window reads when it opens the chat)
   * @param [o.home] the folder a chat without one starts in
   * @param [o.changed] (chatId) => void: every window reads the chat's meta again (chats:changed), for meta a caller
   *   gives a new chat of its own (MoMo's tag), before the chat is announced
   */
  constructor(o) {
    this.o = o;
    this.home = o.home ?? os.homedir();
    this.preparedWorktrees = new Map();
  }

  /**
   * A managed worktree for `cwd`'s repo, with the project's setup script run in it before any harness starts there.
   * `{ unsupported }` (worktreeSupport.mjs's reason) when the folder can't hold one at all (not a Git repository, no
   * commit yet), null when making one failed otherwise: the caller decides whether either is a failure.
   * @param {string} cwd
   * @param {{ branch?: string, what?: string, startPoint?: 'head', baseCommit?: string }} [opts] baseCommit: an exact fetched origin/main repair base
   */
  async newWorktree(cwd, { branch, startPoint, baseCommit, what = 'a scheduled task' } = {}) {
    const prefs = this.o.prefs() || {};
    const root = prefs.worktreeRoot || path.join(this.home, '.mopilot', 'worktrees');
    // Only creation failures may fall back to the project; a failed setup must stop the start.
    const wt = await this.o
      .worktree(cwd, {
        prefix: prefs.branchPrefix,
        root,
        ...(branch ? { branch } : {}),
        ...(startPoint ? { startPoint } : {}),
        ...(baseCommit ? { baseCommit } : {}),
      })
      .catch((error) => {
        noteIgnored(`make a worktree for ${what}`, error);
        return null;
      });
    if (!wt) return null;
    if (!wt.ok && wt.unsupported) return { unsupported: String(wt.error) };
    if (!wt.ok) {
      noteIgnored(`make a worktree for ${what}`, new Error(`Couldn't create worktree: ${wt.error}`));
      return null;
    }
    this.preparedWorktrees.set(wt.path, wt);
    const script = setupScriptOf(baseCommit ? wt.worktree : wt.repo);
    if (script) {
      const result = await this.o.script(wt.worktree, script);
      if (result.exitCode !== 0) throw new Error(`Setup script failed (exit ${result.exitCode}): ${String(result.output ?? '').trim()}`);
    }
    return { path: wt.path };
  }

  /** Cancelling a start may remove only a clean worktree this starter prepared, never a parent's checkout. */
  async discardWorktree(cwd) {
    const owned = this.preparedWorktrees.get(cwd);
    if (!owned || !this.o.discardWorktree)
      return { discarded: false, reason: 'The worktree was retained because this start does not own its removal.' };
    try {
      const result = await this.o.discardWorktree(owned);
      if (result.discarded) this.preparedWorktrees.delete(cwd);
      return result;
    } catch (error) {
      noteIgnored('discard a cancelled start’s prepared worktree', error);
      return { discarded: false, reason: 'The prepared worktree was retained because cleanup could not finish.' };
    }
  }

  /** Native creation may publish even when it fails; from its first callback, cleanup follows the chat's lifecycle. */
  retainWorktree(cwd) {
    return this.preparedWorktrees.delete(cwd);
  }

  /**
   * A new Claude Code chat; with `forkFrom` (a Claude session id in the same folder) its first message continues a
   * copy of that conversation.
   */
  startClaude(cwd, worktreeOf, { forkFrom = null, meta = null, ...picked } = {}) {
    const id = `claude:${crypto.randomUUID()}`;
    const options = this.claudeDefaults(picked);
    this.retainWorktree(cwd);
    this.o.claudeSession(id, { cwd, ...(forkFrom ? { forkFrom } : {}) });
    this.tag(id, this.initialSettings(options, worktreeOf), meta);
    this.o.claudeOwn?.(id, options);
    this.o.started({ harness: 'claude', chatId: id, cwd, worktreeOf });
    return id;
  }

  /** A durable linked Claude fork: unlike a side chat, its first process resumes the copied transcript. */
  async forkClaude(sessionId, cwd, worktreeOf, { meta = null, ...picked } = {}) {
    if (!this.o.claudeFork) throw new Error('Claude persistent fork is not available');
    const options = this.claudeDefaults(picked);
    this.retainWorktree(cwd);
    const copy = await this.o.claudeFork(sessionId, cwd);
    const id = `claude:${copy.sessionId}`;
    this.o.claudeSession(id, { cwd, resume: true });
    this.tag(id, this.initialSettings(options, worktreeOf), meta);
    this.o.claudeOwn?.(id, options);
    this.o.started({ harness: 'claude', chatId: id, cwd, worktreeOf, history: true });
    return id;
  }

  startAcp(harness, cwd, worktreeOf, { meta = null, ...options } = {}) {
    const id = `acp:${harness}:${crypto.randomUUID()}`;
    this.retainWorktree(cwd);
    this.o.acpSession(id, { cwd });
    this.tag(id, this.initialSettings(options, worktreeOf), meta);
    this.o.started({ harness: 'acp', chatId: id, cwd, worktreeOf });
    return id;
  }

  async startCodex(cwd, worktreeOf, { meta = null, isolated = false, ...options } = {}) {
    this.retainWorktree(cwd);
    return this.announceCodex(
      await this.o.codexThread({ cwd, ...(isolated ? { isolated, ...(meta ? { meta } : {}) } : {}), ...options }),
      cwd,
      worktreeOf,
      meta,
      options,
    );
  }

  /** A new Claude chat starts from the new-chat model and effort where it was given none, and keeps its own from here on. */
  claudeDefaults(options) {
    const sel = (this.o.prefs() || {}).claudeSelection || {};
    return { model: sel.model ?? null, effort: sel.effort ?? null, ...options };
  }

  /** Initial per-chat configuration is saved before announcement, so restarts and human follow-ups keep it. */
  initialSettings(options, worktreeOf) {
    const { account, ignored: _ignored, ...config } = options;
    return {
      ...(worktreeOf ? { worktreeOf } : {}),
      ...(Object.keys(config).length ? { config } : {}),
      ...(account ? { account: { id: account, pinned: false } } : {}),
    };
  }

  /**
   * A new chat's meta, written before any window hears of it. `meta` is the caller's own (MoMo's tag, which keeps the chat
   * out of every list): when it can't be saved the chat is not announced, so it never shows untagged.
   */
  tag(id, base, meta) {
    const patch = { ...base, ...meta };
    if (!Object.keys(patch).length) return;
    // patchMeta-changes: a new chat has no meta yet, so its patch always changes
    const saved = this.o.chats.patchMeta(id, patch);
    if (!meta && !base.config && !base.account) return;
    if (!saved) throw new Error("Couldn't save the new chat's settings");
    // windows hear of the chat only after they know its meta, so it never shows where its tag keeps it out
    this.o.changed?.(id);
  }

  /** A Codex chat that continues a copy of thread `threadId`'s conversation, working in `cwd`. */
  async forkCodex(threadId, cwd, worktreeOf, { meta = null, ...options } = {}) {
    if (!this.o.codexFork) throw new Error('Codex fork is not available');
    this.retainWorktree(cwd);
    return this.announceCodex(
      await this.o.codexFork({ threadId, cwd, excludeTurns: true, deferGoalContinuation: true }),
      cwd,
      worktreeOf,
      meta,
      options,
    );
  }

  announceCodex(thread, cwd, worktreeOf, meta = null, options = {}) {
    const prefs = this.o.prefs() || {};
    const id = thread.id;
    // the chat starts from the defaults and keeps its own from here on
    const { account: _account, ignored: _ignored, ...inherited } = options;
    const config = { model: prefs.model ?? null, effort: prefs.effort ?? null, serviceTier: prefs.serviceTier ?? null, ...inherited };
    this.tag(id, { config, ...(worktreeOf ? { worktreeOf } : {}) }, meta);
    this.o.started({ harness: 'codex', chatId: id, cwd, worktreeOf, config });
    return id;
  }
}

module.exports = { ChatStarter, setupScriptOf };
