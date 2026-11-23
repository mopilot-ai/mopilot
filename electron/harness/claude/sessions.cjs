// The live Claude Code CLI processes, one per chat key: starting, feeding, steering and ending them, and the permission and elicitation cards they raise.
const { clock } = require('../../platform/ports/clock.cjs');
const crypto = require('node:crypto');
const { createSessionLifetime } = require('./sessionLifetime.cjs');
const { addDirectories } = require('./directoryGrants.cjs');
const { setNativePermission, applyNativeFlags, observeNativeRestoreMode } = require('./nativeSettings.cjs');
const { moved, settled } = require('./readOnlyBoundary.cjs');
const { replyPermission, planPermissionReply } = require('./permissionReplies.cjs');
const { StderrTail } = require('../stderrTail.cjs');
const { assertInputReady, assertInputCurrent, hasInputReadiness } = require('../../session/contract/inputGuard.cjs');
const { emptyTasks, reduceTasks, taskList, runningTasks, settleAll, noteSchedule, keepAlive } = require('./tasks.cjs');
const { createLiveOutput } = require('./liveOutput.cjs');
const { anyWindowVisible } = require('./windowVisibility.cjs');
const { createRemoteControl } = require('./remoteControl.cjs');
const { createElicitation } = require('./elicitation.cjs');
const { ChromeTabs } = require('./chromeTabs.cjs');
const chromeLink = require('./chromeLink.cjs');
const { autoAllow } = require('../../capabilities/mcp/sdkMcp.cjs');
const { prepareSessionTools } = require('./sessionTools.cjs');
const { noteIgnored, ignoring } = require('../../ignored.cjs');
const { transcriptTip, ownTip, presence, checkpoints } = require('./transcripts.cjs');
const { Channel, wantsReadOnly, restoreMode, buildSessionOptions, buildUserMessage, elicitationResult } = require('./sessionOptions.cjs');

/**
 * @param {import('./state.cjs').ClaudeState} state
 * @param {{ auth: ReturnType<typeof import('./auth.cjs').createAuth>, cli: ReturnType<typeof import('./cli.cjs').createCli>,
 *           catalog: ReturnType<typeof import('./catalog.cjs').createCatalog>,
 *           chrome: ReturnType<typeof import('./chromeSessions.cjs').createChromeSessions>,
 *           handedOff?: (chatId: string | undefined, url: string) => boolean }} deps handedOff: the app's check for a page handed to the user's Chrome
 */
function createSessions(state, { auth, cli, catalog, chrome, handedOff }) {
  const lifetime = createSessionLifetime(state);
  const remote = createRemoteControl(state, { lifetime, note: noteIgnored });
  const { retire } = lifetime;
  const requestElicitation = createElicitation({ state, lifetime, uuid: () => crypto.randomUUID(), result: elicitationResult });
  /** An idle process on credentials that are no longer the ones in use: it restarts at its next turn (a running turn is left alone). */
  const billingStale = (s) => !s.busy && !s.unpersisted && auth.sessionStale(s);

  /**
   * End the idle processes that started on other credentials, never a running turn, an open card, a side chat, one with
   * background work or one whose Claude in Chrome group holds the chat's pages (it restarts at its next turn instead).
   * A Remote Control link does not keep it: stale credentials must end, and the saved bridge is reattached at the next start.
   * Each ends gracefully, so its exit hooks run (Claude in Chrome closes a blank group).
   */
  function restartIdle() {
    const now = clock.now();
    for (const [key, s] of [...state.sessions])
      if (!s.keep && billingStale(s) && !s.perms.size && !keepAlive(s.tasks, s.sched, now) && !s.chrome?.holdsPages()) void retire(key);
  }

  /**
   * The session's ultracode as the CLI applies it. getSettings is in the SDK at runtime but not in
   * its types (C6), so it's a version probe: without it the switch is greyed, nothing else changes.
   */
  async function readSettings(s) {
    let out;
    const perTaskStop = typeof s.q?.stopTask === 'function';
    // whether this process loaded MoPilot's plugin folders (its CLI takes --plugin-dir): the plugins probe
    const plug = typeof s.pluginDirs === 'boolean' ? { pluginDirs: s.pluginDirs } : {};
    if (typeof s.q?.getSettings !== 'function') out = { probe: 'missing', ultracode: false, available: false, perTaskStop, ...plug };
    else
      try {
        const a = (await s.q.getSettings())?.applied ?? {};
        out = {
          probe: 'ok',
          ultracode: !!a.ultracode,
          available: a.ultracodeAvailable !== false,
          perTaskStop,
          ...plug,
          origin: 'ultracodeRequested' in a,
        };
      } catch {
        out = { probe: 'failed', ultracode: false, available: false, perTaskStop, ...plug };
      }
    if (!lifetime.active(s)) return out;
    s.applied = out;
    state.emit({ key: s.key, kind: 'settings', ...out });
    return out;
  }

  async function startSession(key, opts) {
    const { query } = await state.sdk();
    const bin = await cli.findBinary(opts.bin);
    if (!bin) throw new Error('Claude Code is not installed');
    // at the cap, the least recently active idle CLI ends to make room (harness/claude/governor.cjs)
    state.beforeStart?.();
    const input = new Channel();
    let finished;
    const s = {
      key,
      readOnly: wantsReadOnly(opts),
      account: opts.account ?? state.activeAccount(),
      billing: auth.billingSig(),
      configId: auth.configIdOf(opts.account),
      restoreMode: restoreMode(opts.permission === 'plan' ? opts.basePermission : opts.permission),
      tasks: emptyTasks(),
      sched: { crons: 0, wakeAt: 0 },
      input,
      q: /** @type {import('@anthropic-ai/claude-agent-sdk').Query | null} */ (null),
      perms: new Map(),
      seen: new Set(),
      busy: false,
      /** the CLI is answering something it started itself (a background task's wake-up), not a prompt Sage sent */
      woken: false,
      lastActive: clock.now(),
      stderr: new StderrTail(2000),
      done: new Promise((r) => (finished = r)),
    };
    // the chat the process serves (retireChat, its Claude in Chrome link), looked up at each read like its tools'
    // owner: a process started without its chat finds it once the chat records the session
    const chatOfProcess = () => opts.chatId || state.chatOf(key);
    // MoMo's chat (kept apart) has no Claude in Chrome: it reaches Chrome through its own chrome_* tools (harness/claude/isolation.cjs)
    s.isolated = state.isolated?.(chatOfProcess()) === true;
    s.nativeChrome = !s.isolated && auth.nativeChromeFor(s.account);
    Object.defineProperty(s, 'chatId', { get: chatOfProcess, enumerable: true });
    // what its Claude in Chrome results say its tab group holds (a site handed off for its chat's sign-in is the user's)
    s.chrome = s.nativeChrome ? new ChromeTabs({ chatOf: () => s.chatId, handedOff }) : null;
    // whether its Claude in Chrome is connected, and to which browser (electron/harness/claude/chromeLink.cjs)
    s.link = s.nativeChrome ? new chromeLink.ChromeLink() : null;
    s.sent = 0;
    s.results = 0;
    /** prompts sent that haven't had their result yet */
    s.owed = 0;
    const options = buildSessionOptions(opts, {
      bin,
      nativeChrome: s.nativeChrome,
      env: auth.sessionEnv(s.account, s),
      stderr: (d) => s.stderr.push(d),
      spawn: state.spawn ? (o) => state.spawn(o, (d) => s.stderr.push(d), key) : undefined,
      onSpawned: (pid) => lifetime.watch(s, pid),
      // MoPilot's own tools are authorized in their handlers, not by a second card here
      canUseTool: (toolName, toolInput, o) =>
        !lifetime.active(s)
          ? Promise.resolve({ behavior: 'deny', message: 'Session closed' })
          : (s.sageTools && autoAllow(s.sageTools, toolName, toolInput)) || requestPermission(s, toolName, toolInput, o),
      // an MCP server asking the user for input (a form or a sign-in link); unanswered, the SDK declines
      onElicitation: (request, o) => requestElicitation(s, request, o),
    });
    await prepareSessionTools(state, cli, bin, options, s, opts, key, chatOfProcess);
    if (opts.forkFrom) {
      // side chat: branch off another session without writing a transcript (like Codex's ephemeral forks)
      options.resume = opts.forkFrom;
      options.forkSession = true;
      options.persistSession = false;
      s.keep = true;
    } else if (opts.resume) options.resume = opts.sessionId;
    else options.sessionId = opts.sessionId;
    // an edited message: the conversation goes on from just before it (rewind())
    if (options.resume && state.resumeAt.has(key)) options.resumeSessionAt = state.resumeAt.get(key);
    state.resumeAt.delete(key);
    if (opts.ephemeral) {
      // a temporary chat: nothing on disk, so it lives in this process on the account it started on (C10)
      s.keep = true;
      options.persistSession = false;
    }
    s.unpersisted = options.persistSession === false;
    s.cwd = opts.cwd;
    let q;
    try {
      q = query({ prompt: input, options });
    } catch (e) {
      // the stream loop that lets go of the plugin folders never starts
      s.releasePlugins?.();
      throw e;
    }
    s.q = q;
    // output of a running Bash command (D-68, C24); SAGE_CLAUDE_LIVE_OUTPUT=0 turns it off
    s.live =
      process.env.SAGE_CLAUDE_LIVE_OUTPUT === '0'
        ? null
        : createLiveOutput({
            q: s.q,
            visible: anyWindowVisible,
            emit: (msg) => lifetime.active(s) && state.emit({ key, kind: 'message', msg, login: s.billing === 'subscription' }),
          });
    // unpersisted sessions write no transcript, so there's nothing on disk to keep in step with
    s.sessionId = s.unpersisted ? null : opts.sessionId;
    state.sessions.set(key, s);
    lifetime.claim(s);
    state.emit({ key, kind: 'processStarted', cwd: s.cwd });
    // whether this process runs Claude in Chrome is fixed now: the chat's controller plan reads it
    state.onProcess(s.chatId, key);
    // background tasks belong to a process: a new one starts with none
    state.emit({ key, kind: 'tasks', tasks: [] });
    (async () => {
      try {
        for await (const msg of q) {
          if (!lifetime.active(s)) continue;
          observeNativeRestoreMode(s, msg);
          s.lastActive = clock.now();
          if (s.sessionId && msg.type === 'system' && msg.subtype === 'init') s.tip = transcriptTip(s.sessionId);
          if (msg.type === 'system' && msg.subtype === 'init' && !s.applied)
            // settings are read again on the next change; the session runs without them
            readSettings(s).catch((error) => noteIgnored("read a Claude Code session's settings", error));
          if (msg.type === 'system' && (msg.subtype === 'init' || msg.subtype === 'commands_changed')) catalog.noteCatalog(s, msg);
          remote.onMessage(s, msg, !opts.resume && !state.prewarmed.has(key));
          if (reduceTasks(s.tasks, msg)) state.emit({ key, kind: 'tasks', tasks: taskList(s.tasks) });
          noteSchedule(s.sched, msg);
          s.live?.onMessage(msg);
          if ((msg.type === 'assistant' || msg.type === 'stream_event') && !s.busy) s.woken = true;
          if (msg.type === 'assistant' && msg.uuid) s.seen.add(msg.uuid);
          s.chrome?.note(msg);
          const linkCheck = s.link?.note(msg);
          if (linkCheck) void chrome.checkChromeLink(s, linkCheck);
          if (msg.type === 'result') {
            // a prompt sent into the running turn gets a result of its own: the turn goes on until the last
            s.owed = Math.max(0, s.owed - 1);
            s.busy = s.owed > 0;
            s.woken = false;
            s.results++;
            // a group left with only blank tabs, or a chat archived mid-turn: the idle CLI ends, and its exit hook closes the group
            if (s.chrome?.blankOnly() || s.retireAfterTurn) retireLater(s);
            // a browser picked in settings during the turn applies now that it ended
            if (!s.busy && s.pendingBrowser)
              chrome
                .browserAfterTurn(s)
                .catch((error) => noteIgnored('move a Claude Code session to the browser picked in settings', error));
            // the CLI may append a line or two after its result (an interrupt marker, say)
            clock.clearTimeout(s.tipTimer);
            if (s.sessionId) s.tipTimer = clock.setTimeout(settleTip, 250, s);
          }
          state.emit({ key, kind: 'message', msg, login: s.billing === 'subscription', account: s.account });
        }
        // a process replaced by send() is followed by its successor; its end isn't the chat's
        if (lifetime.speaks(s)) state.emit({ key, kind: 'closed' });
      } catch (e) {
        if (lifetime.speaks(s)) state.emit({ key, kind: 'error', error: String(e?.message || e), stderr: s.stderr.text });
      } finally {
        // what the process still ran in the background ended with it
        if (settleAll(s.tasks) && lifetime.speaks(s)) state.emit({ key, kind: 'tasks', tasks: taskList(s.tasks) });
        if (lifetime.speaks(s)) remote.onEnd(s);
        s.live?.close();
        for (const [requestId, resolve] of s.perms) {
          resolve({ behavior: 'deny', message: 'Session closed' });
          state.emit({ key, kind: 'permissionCancelled', requestId });
        }
        s.perms.clear();
        if (s.toolKey) state.sageTools?.sessions.end(s.toolKey);
        // its plugin folders may go once no other session holds them
        s.releasePlugins?.();
        // the chat has no link once its session ends (a session that replaces it reads its own)
        if (s.link && lifetime.owns(s)) state.onChromeLink(s.chatId, null, key);
        try {
          state.accts?.syncBack(s.configId);
        } catch (error) {
          // the next session on this login syncs again
          noteIgnored("carry a Claude Code account's config back", error);
        }
        // a change notice can arrive after the process is gone (an edit closes it at once): what it last
        // wrote stays Sage's own
        if (s.sessionId && lifetime.owns(s)) {
          settleTip(s);
          if (s.tip) state.endedTips.set(s.sessionId, s.tip);
          else state.endedTips.delete(s.sessionId);
        }
        if (state.sessions.get(key) === s) state.sessions.delete(key);
        lifetime.finish(s);
        finished();
      }
      // the loop reports the session's own end and errors above; this is only its cleanup failing
    })().catch(ignoring("clean up after a Claude Code session's process ended"));
    return s;
  }

  function requestPermission(s, toolName, toolInput, o) {
    // the SDK may give up on a request before it reaches us (an interrupt): no card for it
    if (o?.signal?.aborted) return Promise.resolve({ behavior: 'deny', message: 'Cancelled' });
    return new Promise((resolve) => {
      const requestId = `cperm-${crypto.randomUUID()}`;
      const finish = (result) => {
        o?.signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => {
        if (!s.perms.delete(requestId)) return;
        finish({ behavior: 'deny', message: 'Cancelled' });
        state.emit({ key: s.key, kind: 'permissionCancelled', requestId });
      };
      // read when answered: the chat's permission may have changed while the card was up
      s.perms.set(requestId, planPermissionReply({ state, lifetime, s, toolName, options: o, requestId, finish }));
      s.lastActive = clock.now();
      o?.signal?.addEventListener('abort', abort, { once: true });
      state.emit({
        key: s.key,
        kind: 'permission',
        requestId,
        toolName,
        input: toolInput,
        toolUseID: o?.toolUseID ?? null,
        agentID: o?.agentID ?? null,
        displayName: o?.displayName ?? null,
        suggestions: o?.suggestions ?? null,
        blockedPath: o?.blockedPath ?? null,
        title: o?.title ?? null,
        description: o?.description ?? null,
        decisionReason: o?.decisionReason ?? null,
      });
    });
  }

  async function send(key, opts, message, priority, meta = {}) {
    await settled(state.sessions.get(key), priority); // a grace after the CLI's idle is over before this send decides (readOnlyBoundary.cjs)
    // another send is replacing or starting this chat's CLI (no CLI is live meanwhile, so a steer comes here as a
    // turn): wait for it and use the CLI it starts, rather than start a second one on the same session
    while (state.starting.has(key)) await state.starting.get(key);
    let s = state.sessions.get(key);
    // a CLI warmed when its chat was opened (warm.cjs) and any CLI this send starts in its place are the chat's from its first send
    if (s?.warmOnly) s.warmOnly = false;
    state.prewarmed.delete(key);
    // The chat moved to another account, or another app (Claude desktop, the CLI) added to the session since this process last wrote it: a
    // live CLI only knows the history it has in memory, so it would answer without those turns and branch the transcript off its own older
    // tip, hiding them. End it and resume from disk. (an unpersisted session can't be resumed elsewhere, so it stays on its account)
    const replace =
      !!s && !priority && ((opts.account && s.account !== opts.account && !s.unpersisted) || billingStale(s) || stale(s) || moved(s, opts));
    if (!s || replace) {
      const old = s;
      const job = (async () => {
        if (old) {
          old.replaced = true;
          // it ends gracefully, so its exit hooks run (Claude in Chrome closes a group left with only blank tabs)
          await retire(key);
        }
        // a CLI still running its exit hooks for this conversation quits before the next one resumes it
        if (state.retiring.has(key)) await state.retiring.get(key);
        return startSession(key, opts);
      })();
      // the others wait for it either way (a start that failed leaves them to start their own); the failure itself
      // reaches this send's caller below
      const entry = job.then(
        () => undefined,
        () => undefined,
      );
      state.starting.set(key, entry);
      try {
        s = await job;
      } finally {
        if (state.starting.get(key) === entry) state.starting.delete(key);
      }
    } else if (opts.permission) s.restoreMode = restoreMode(opts.permission === 'plan' ? opts.basePermission : opts.permission);
    if (hasInputReadiness(meta)) await assertInputReady(meta);
    assertInputCurrent(meta);
    if (!lifetime.active(s)) throw new Error('Session closed before this message was sent');
    s.busy = true;
    s.owed++;
    s.sent++;
    s.lastActive = clock.now();
    const msg = buildUserMessage(message, { ...meta, priority, literal: s.isolated || state.isolated?.(opts.chatId) === true });
    // the CLI writes the prompt under this uuid; a prompt with no reply after it (a local command
    // like "/goal clear") is still this process's own line
    s.seen.add(msg.uuid);
    s.input.push(msg);
    return { elsewhere: s.sessionId ? ((await presence())[s.sessionId] ?? []) : [] };
  }

  /** After a turn: take the transcript's tip as this process's own, or mark it behind (tip false). */
  function settleTip(s) {
    clock.clearTimeout(s.tipTimer);
    s.tipTimer = null;
    s.tip = ownTip(s);
  }

  /** Whether the transcript has moved past what this idle process last saw. */
  function stale(s) {
    if (s.busy || !s.sessionId) return false;
    if (s.tipTimer) settleTip(s);
    return s.tip === false || (s.tip !== undefined && transcriptTip(s.sessionId) !== s.tip);
  }

  async function control(key, method, arg) {
    const s = state.sessions.get(key);
    if (!s) return null;
    s.lastActive = clock.now();
    const current = () => {
      if (!lifetime.active(s)) throw new Error('The Claude process changed before its settings update completed');
    };
    switch (method) {
      case 'interrupt':
        // the CLI drops queued prompts on interrupt, so the next result ends the turn
        s.owed = Math.min(s.owed, 1);
        return s.q.interrupt();
      case 'setModel':
        return s.q.setModel(arg || undefined);
      case 'addDirectories':
        return addDirectories(s, arg, current);
      case 'setPermissionMode':
        return setNativePermission(s, arg, current);
      case 'applyFlagSettings':
        return applyNativeFlags(s, arg, current, readSettings);
      case 'remoteControl':
        return remote.set(s, !!arg?.on, arg);
      case 'stopTask':
        return s.q.stopTask(String(arg));
      // the running foreground command or agent (or the one tool call `arg` names) keeps running as a background task
      case 'backgroundTasks':
        return s.q.backgroundTasks(arg ? String(arg) : undefined);
      // the context panel's breakdown (arg.detail 'full': every category counted by the API), and the MCP views
      case 'contextUsage':
        return s.q.getContextUsage({ detail: arg?.detail === 'full' ? 'full' : 'summary' });
      case 'mcpStatus':
        return s.q.mcpServerStatus();
      case 'toggleMcp':
        return s.q.toggleMcpServer(String(arg?.name), !!arg?.enabled);
      case 'reconnectMcp':
        return s.q.reconnectMcpServer(String(arg?.name));
      // the CLI's own session title (a side query on its small model, beside the turn); MoPilot saves it itself, so
      // a name the user gave meanwhile wins. A CLI too old for the request rejects it, and the caller falls back.
      case 'generateTitle':
        if (typeof s.q.generateSessionTitle !== 'function') return null;
        return s.q.generateSessionTitle(String(arg ?? ''), { persist: false });
      case 'stopAllTasks':
        // a task may have finished on its own meanwhile
        for (const t of runningTasks(s.tasks))
          await s.q.stopTask(t.id).catch((error) => noteIgnored('stop a Claude Code background task', error));
        return true;
      case 'close':
        s.input.close();
        try {
          s.q.close();
        } catch (error) {
          // the query may already be closed
          noteIgnored('close a Claude Code query', error);
        }
        state.sessions.delete(key);
        return true;
      default:
        throw new Error(`Unknown control ${method}`);
    }
  }

  /** Whether an idle CLI may end now: no turn, card, side chat, background task or scheduled wake-up would be lost. */
  const retirable = (s, now = clock.now()) =>
    state.sessions.get(s.key) === s && !s.keep && !s.busy && !s.perms.size && !keepAlive(s.tasks, s.sched, now);

  /** End the CLI shortly after its turn, unless a message is still unanswered, or a new one or a card came meanwhile. */
  function retireLater(s) {
    const sent = s.sent;
    clock.clearTimeout(s.retireTimer);
    s.retireTimer = clock.setTimeout(() => {
      if (s.sent === sent && s.results >= sent && retirable(s) && !remote.holds(s)) void retire(s.key);
    }, state.timing.blankGroupMs);
    s.retireTimer.unref();
  }

  /**
   * A chat archived, deleted or cleared (/clear starts a new chat): its idle CLIs end gracefully now, a
   * running one after its turn. Side chats and CLIs with background work stay, as for the idle reaper.
   * @returns {number} how many CLIs of the chat end now
   */
  function retireChat(chatId, { cleared = false } = {}) {
    let n = 0;
    for (const s of [...state.sessions.values()]) {
      if (s.chatId !== chatId || s.keep) continue;
      // its Remote Control link comes down first: an archived chat is not steerable from claude.ai
      const down = remote.release(s.sessionId, s, { cleared });
      if (retirable(s)) {
        if (down) void down.then(() => retire(s.key));
        else void retire(s.key);
        n++;
      } else if (s.busy) s.retireAfterTurn = true;
    }
    return n;
  }

  /**
   * Edit-and-resend (D-68): rewind the files to before `uuid` (dryRun lists them first), then end the
   * process so the next message resumes the conversation just before it.
   */
  async function rewind(key, opts, uuid, dryRun) {
    const s = state.sessions.get(key) ?? (await startSession(key, { ...opts, resume: true }));
    // the conversation must be able to go back too, or only the files would
    const before = s.sessionId ? (await checkpoints(s.sessionId))[uuid] : null;
    // a busy turn, checked after the read: one may start meanwhile, or another process take the key
    if (state.sessions.get(key) !== s || s.busy) throw new Error('Wait for this turn to finish');
    if (!before) return { canRewind: false, error: 'This message has nothing before it to go back to' };
    const r = await s.q.rewindFiles(uuid, { dryRun });
    if (dryRun || !r?.canRewind) return r;
    state.resumeAt.set(key, before);
    s.replaced = true;
    // it ends gracefully, so its exit hooks run (Claude in Chrome closes a group left with only blank tabs)
    await retire(key);
    return r;
  }

  return {
    restartIdle,
    billingStale,
    readSettings,
    startSession,
    send,
    stale,
    control,
    remote,
    retire,
    retireChat,
    retirable,
    resolvePermission: (requestId, result) => replyPermission(state, requestId, result),
    rewind,
  };
}

module.exports = { createSessions };
