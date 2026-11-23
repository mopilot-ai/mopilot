// One run of a scheduled task, in main (A15, WP7-18): the scheduler and "Run now" both come here, so a
// task starts the same way either way: on its harness (Codex, Claude Code or a basic one), in its folder or a fresh
// worktree, with its model and effort, and with the run's chat marked (computer control, what to do on
// approval). No window is needed: the chat is made here, the message goes through the ChatController,
// and a window that is open is told about the new chat so its sidebar and thread list have it.
const { ownTable } = require('../../shared/ownTable.mjs');
const {
  runWithOf,
  acpHarnessOf,
  scheduledMark,
  wantsWorktree,
  runSendOptions,
  machineOf,
  machineHarnessOf,
} = require('../../shared/scheduleTask.mjs');
const { ChatStarter, setupScriptOf } = require('./chatStart.cjs');

const LABEL = ownTable({ codex: 'Codex', claude: 'Claude Code' });

class AutomationRunner {
  /**
   * @param {object} o
   * @param o.prefs () => the app's prefs
   * @param o.usable (kind: 'codex'|'claude'|'acp:<id>', {unattended}) => Promise<boolean>: installed, signed in, not switched off
   * @param o.sessions SessionStore
   * @param o.send (chatId, item, origin) => Promise<{started?: boolean, error?: string} | {action: string}>: the message
   *   sent through the ChatController; in an idle chat, once its start is known
   * @param o.codexThread ({cwd}) => Promise<thread>: a new Codex thread, held by Sage (CodexAdapter.startThread)
   * @param o.claudeSession (key, {cwd}) => void: a new Claude session the first message starts (ClaudeAdapter.registerSession)
   * @param o.acpSession (key, {cwd}) => void: a new basic-tier session the first message starts (AcpTurns.registerSession)
   * @param [o.label] (kind) => string: a harness's name, for a basic one
   * @param o.chats ChatsStore (patchMeta)
   * @param o.worktree (cwd) => Promise<{ok, path, worktree, repo, error}>: platform/git.cjs worktreeAdd
   * @param o.script (cwd, script) => Promise<{exitCode, output}>: platform/git.cjs runScript
   * @param o.remember (automation, chatId) => Promise<unknown>: conditionally remember a heartbeat chat: AutomationStore.rememberChat
   * @param o.started (event) => void: a chat was made, for the windows that are open
   * @param [o.record] (automation, chatId, harness) => Promise<void>: record an attended run in history
   * @param [o.home] the folder a run without one starts in
   * @param [o.machine] () => the Host's chat starter for machines (electron/app/ipc/host.cjs live.machineChats), or
   *   undefined while Host is not wired: a task with a `host_id` runs there
   */
  constructor(o) {
    this.o = o;
    this.starter = new ChatStarter(o);
  }

  /** The folder a run without one starts in. */
  get home() {
    return this.starter.home;
  }
  set home(dir) {
    this.starter.home = dir;
  }

  /**
   * Start a run and send the task's prompt. Resolves to the chat the run is in.
   * @param a the task (automation.toml)
   * @param {object} opts
   * @param opts.unattended true for runs the scheduler starts: nobody is watching
   * @param [opts.origin] the window that asked (Run now), for its message to show there
   */
  async run(a, { unattended, origin = null }) {
    if (a.transfer_from) throw new Error('This task is waiting to finish switching apps. Try again after its previous app is closed.');
    const kind = runWithOf(a);
    const hostId = machineOf(a);
    if (hostId) return this.runOnMachine(a, hostId, { unattended });
    if (!(await this.o.usable(kind, { unattended })))
      // a basic harness is signed in and installed from Settings → Other agents: the harness menu has none
      throw new Error(
        LABEL[kind]
          ? `${LABEL[kind]} isn’t available. Open the harness menu to sign in or install it.`
          : `${this.o.label?.(kind) ?? kind} isn’t available. Sign in or install it in Settings → Other agents.`,
      );
    let chatId = a.kind === 'heartbeat' ? (a.target_thread_id ?? null) : null;
    if (!chatId) {
      chatId = await this.startChat(a, kind);
      // "Start each run in new chat" off: later runs continue in this chat
      if (a.kind === 'heartbeat') await this.rememberChat(a, chatId);
    }
    this.o.sessions.patch(chatId, { scheduled: scheduledMark(a, unattended) });
    const sent = await this.o.send(chatId, { text: String(a.prompt ?? ''), attachments: [], opts: runSendOptions(a) }, origin);
    if (!unattended && this.o.record) await this.o.record(a, chatId, kind);
    // the chat exists and keeps the message in its queue, but the run did not start: it is reported as failed (one a
    // window holds to send once the chat is free, or a superseded command, is not a failure)
    if (sent?.started === false && !sent.held && !sent.discarded)
      throw Object.assign(new Error(`The task’s message didn’t start: ${sent.error ?? 'the harness refused it'}`), { chatId });
    return chatId;
  }

  /**
   * A run on a remote machine: its chat starts there the way the composer starts one (machineChatStart.cjs), and its message goes through
   * the outbox, so a machine that is away gets it when it answers. A machine that can't run it (removed, agent missing or signed out,
   * Host off) fails the run with the reason.
   * @param a the task @param {string} hostId @param {{ unattended: boolean }} opts
   */
  async runOnMachine(a, hostId, { unattended }) {
    const machine = this.o.machine?.();
    if (!machine) throw new Error('Host isn’t available, so this task can’t run on its machine.');
    const harness = machineHarnessOf(a);
    const folder = a.cwds?.[0];
    if (!folder) throw new Error('Pick a folder on the machine for this task.');
    let chatId = a.kind === 'heartbeat' ? (a.target_thread_id ?? null) : null;
    if (chatId) {
      // a heartbeat's chat goes on there: a machine that can't run it now fails the run instead of holding a message nobody sees
      const r = machine.readiness(hostId, harness);
      if (!r.ok) throw r.error;
    } else {
      chatId = machine.newChatId(harness);
      const projectId = typeof a.project_id === 'string' && a.project_id ? a.project_id : null;
      await machine.start({ chatId, hostId, folder, harness, projectId });
      this.o.started({ harness: 'acp', chatId, cwd: folder, worktreeOf: null, hostId, projectId });
    }
    this.o.sessions.patch(chatId, { scheduled: scheduledMark(a, unattended) });
    const sent = await machine.send(chatId, { text: String(a.prompt ?? ''), attachments: [], opts: runSendOptions(a) });
    if (!unattended && this.o.record) await this.o.record(a, chatId, runWithOf(a));
    // queued is not a failure: the machine is away and the outbox sends it when it answers ("Waiting for host" in the chat)
    if (!sent || sent.action === 'failed')
      throw Object.assign(new Error(`The task’s message didn’t start: ${sent?.error ?? 'Host is off'}`), { chatId });
    // a heartbeat goes on in this chat only once its first message (which starts it there) is sent or kept for the machine
    if (a.kind === 'heartbeat' && !a.target_thread_id) await this.rememberChat(a, chatId);
    return chatId;
  }

  /** Persist the startup result through the store's conditional metadata operation. */
  rememberChat(a, chatId) {
    return this.o.remember(a, chatId);
  }

  /** A managed worktree for a run in `cwd`'s repo, set up by the project's script (ChatStarter.newWorktree). */
  newWorktree(cwd) {
    return this.starter.newWorktree(cwd);
  }

  async startChat(a, kind) {
    const base = a.cwds?.[0] ?? this.home;
    let cwd = base;
    // "Run on this computer" off: run in a fresh worktree of the project
    // a worktree that can't be made (not a Git repository, say) runs the task in the project itself
    const made = wantsWorktree(a) ? await this.newWorktree(base) : null;
    const wt = made && 'path' in made ? made : null;
    if (wt) cwd = wt.path;
    const worktreeOf = wt ? base : null;
    if (kind === 'claude') return this.starter.startClaude(cwd, worktreeOf);
    const acp = acpHarnessOf(a);
    return acp ? this.starter.startAcp(acp, cwd, worktreeOf) : this.starter.startCodex(cwd, worktreeOf);
  }
}

module.exports = { AutomationRunner, setupScriptOf };
