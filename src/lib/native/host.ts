// window.native.host's types (Host's closed-alpha gate and the user's remote machines), merged into NativeApi; the calls are declared in electron/bridge/host.cjs.
import type { ChatGoal } from '../../../shared/model/store';
import type { ChatConfig } from '../../../shared/model/window';
import type { HostSidebarRepositoryQuery } from '../../../shared/model/repositorySidebar';
type HostSideChat = { chatId: string; hostId: string; cwd: string; config: ChatConfig };
/** What a machine's Host says about the repository in a folder (host/src/hostRead.mjs): files with their added and removed lines against the base branch, untracked ones listed, with their lines counted (`counted`) for the first 20 small text files. */
export type HostGitStatus =
  | { isRepo: false }
  | {
      isRepo: true;
      branch: string | null;
      head: string | null;
      remote: string | null;
      files: { path: string; added: number; removed: number; binary?: boolean; untracked?: boolean; counted?: boolean }[];
      truncated: boolean;
      unreadable: boolean;
    };
/** The branches of the repository holding a folder on a machine (host/src/hostRead.mjs branches): the branch picker's list, `top` the repository's top folder and `sub` the folder's place in it ('' at the top). */
export type HostBranches =
  | { isRepo: false }
  | { isRepo: true; current: string | null; default: string | null; branches: string[]; commits: boolean; top: string; sub: string };
/** A repository's patch on a machine (host/src/hostRead.mjs diff): at most about 4 MB, `truncated` when the Host cut it, `unreadable` when git could not read the changes. */
export type HostDiff =
  | { isRepo: false }
  | {
      isRepo: true;
      patch: string;
      truncated: boolean;
      unreadable: boolean /** the files in conflict, relative to the folder; absent from an older Host */;
      conflicted?: string[];
    };
/** How a commit or discard on a machine ended (host/src/hostWrite.mjs): git's own refusal is `ok: false` with its words (`refused`: a sentence for the user), `warning` when committed with something to tell. */
/** What a machine's Host says one turn changed: see `gitTurnDiff`. */
export type HostTurnDiff =
  | { isRepo: false }
  | { isRepo: true; baseline: false }
  | {
      isRepo: true;
      baseline: true;
      patch: string;
      truncated: boolean /** untracked files the Host left out of its snapshots as too big: how many, and the first few */;
      skipped?: { count: number; paths: string[] };
    };

export type HostWriteResult = { ok: boolean; stderr: string; refused?: true; warning?: string };
/** A folder's entries on a machine, folders first (host/src/hostFiles.mjs); `truncated` when the folder holds more than the Host lists. */
/** One slash command or skill an agent on a machine offers: `insert` is the text the composer puts in the message for it. */
export type HostCommand = { name: string; description: string; hint?: string; kind: 'command' | 'skill'; insert: string };
export type HostCommandList = { listed: boolean; commands: HostCommand[]; outdated?: true };
export type HostTree = { path: string; entries: { name: string; isDirectory: boolean }[]; truncated: boolean };
/** The start of a file on a machine: its text (cut at the bound, `truncated`), or its size when it is binary. */
export type HostFileView = { kind: 'text'; text: string; size: number; truncated: boolean } | { kind: 'binary'; size: number };
export type HostListing = { path: string; roots: string[]; entries: { name: string; path: string; git: boolean }[] };
export type HostPlace = { path: string; existed: boolean };
/** What reading a sent picture back from its machine answers. */
export type HostPictureReply =
  | { picture: string }
  | { offline: string }
  | { retry: string }
  | { blocked: string }
  | { update: string }
  | { gone: true; machine?: string };
/** What a folder call answers: its value, or the refusal with its `code` (an Error's own code does not survive the bridge). */
export type HostReply<T> = { value: T; error?: undefined } | { value?: undefined; error: { message: string; code?: string } };
export type HostSigninView = {
  hostId: string;
  harness: string;
  state: 'starting' | 'waiting' | 'signed-in' | 'failed' | 'cancelled' | 'expired' | 'unreachable';
  codes: string[];
  link: boolean;
  /** the vendor page this sign-in opened on this Mac, to open again from the row; null until one was */
  url: string | null;
  error: string | null;
  /** Why a failure has a specific recovery action. */
  reason?: 'no_page' | 'host_update' | null;
  /** One main-owned Git sign-in and the interrupted operations explicitly joined to it. */
  attemptId?: string;
  recoveryKeys?: string[];
};

/** How Sign out everywhere went on one machine (electron/host/signOut.cjs). */
export type HostSignOutResult = {
  id: string;
  name: string;
  state: 'done' | 'partial' | 'offline' | 'failed';
  agents: { id: string; label: string; signedOut: boolean; error: string | null }[];
  error: string | null;
};
/** How installing a missing agent on a machine stands (electron/host/machineInstall.cjs). */
export type HostInstallView = {
  hostId: string;
  harness: string;
  state: 'queued' | 'running' | 'installed' | 'failed' | 'cancelled' | 'unreachable';
  line: string;
  error: string | null;
  version: string | null;
};

/** What one agent on a machine is ready for, and why not when it is not. */
/** A machine the Add machine picker offers (electron/host/discovery.cjs). */
export type HostFoundMachine = {
  source: 'network' | 'tailscale' | 'config';
  name: string;
  destination: string;
  detail: string;
  address: string;
  alias: string;
  added: boolean;
  /** a Mac on this network that does not offer ssh: its Remote Login is off */
  remoteLoginOff?: boolean;
};
/** What ssh asks while a machine is added (electron/host/sshPrompt.cjs). */
export type { HostSshPrompt } from './contracts/hostPrompt';
import type { HostSshPrompt } from './contracts/hostPrompt';
/** one line of an add (electron/host/install.cjs) */
export type HostInstallStep = import('../../../shared/host/installFailure.mjs').InstallStep;
export type HostAgent = import('../../../shared/host/agentReadiness.mjs').HostAgent;
export type HostMachineRow = {
  id: string;
  name: string;
  /** the name itself, without the address a second machine of that name adds; Rename starts from it */
  rawName?: string;
  status: 'online' | 'offline' | 'attention';
  note: string;
  signin: string | null;
  agents: HostAgent[];
  /** the missing agents this machine's Host can install itself (empty for an older Host, or one offline) */
  installable?: string[];
  /** how the machine is reached (#2709): the path mode, whether it has a relay path, the path in use and the relay's round trip */
  path?: { mode: HostPathMode; relay: boolean; path: 'ssh' | 'relay' | null; latencyMs: number | null };
  /** when the machine last answered (ms), null when it never has */
  lastSeen?: number | null;
  linkDroppedAt?: number;
  hostStopped?: true;
  /** whether the machine's Host may reach its local network ('unknown' while offline, or from an older Host): macOS Local Network privacy */
  localNetwork?: 'allowed' | 'denied' | 'unknown';
  /** an offline machine nobody is signed in on: it restarted since it last answered, or was signed out; `locked`: FileVault holds its disk */
  waitingForLogin?: 'restarted' | 'signed-out' | 'locked' | null;
  /** whether the machine's Host starts at boot, before anyone signs in (Keep running after restart; Linux lingering) */
  startsAtBoot?: 'yes' | 'no' | 'unknown';
  /** a Mac's FileVault, as its Host last said */
  fileVault?: 'on' | 'off' | 'unknown';
  /** the system the machine's Host runs on ('' when it never said) */
  platform?: 'darwin' | 'linux' | '';
  /** waiting cards its Host last said found no phone linked to push to, present only when there are some */
  pushSkipped?: number;
  /** a cloud machine's provider record (host.cloud), absent on any other */
  cloud?: CloudRecord;
};

/** What a machine chat waits for (the Host's `attention`, shared/host/attentionLine.mjs). */
export type HostAttention = {
  kind: 'approval' | 'paused' | 'credential' | 'limit';
  reason?: string;
  since?: number;
  pauseMinutes?: number;
};

/** Add by command: `waiting` shows the command, `asking` the machine that ran it (its name, system, user and where it connected from); after Allow, `joining`, then `ready` or `join_failed` with `error` saying why. */
export type HostBootView = {
  state: 'idle' | 'waiting' | 'asking' | 'joined' | 'joining' | 'ready' | 'join_failed' | 'denied' | 'expired' | 'failed';
  command: string;
  expiresAt: number;
  machine: { name: string; os: string; arch: string; user: string; ip: string } | null;
  error: string;
};

/** A provider the New cloud machine sheet offers (electron/host/cloudService.cjs): the key fields it takes, and whether a key is kept (the key is never returned). */
export type CloudProvider = { id: string; label: string; fields: string[]; hasKey: boolean };
export type CloudSize = { id: string; label: string; cpus: number; memoryGb: number; pricePerHour: number | null; currency: string };
/** What the sheet's Machine step shows: what the provider can do (`reasons` says why for each flag that is false), its sizes and regions. */
export type CloudOptions = {
  flags: Record<string, boolean>;
  reasons: Record<string, string>;
  sizes: CloudSize[];
  regions: { id: string; label: string }[];
};
export type CloudStepId = 'create' | 'start' | 'connect' | 'pair';
/** What the cloud service tells the window (electron/host/cloudService.cjs onEvent). */
export type CloudEvent =
  | { kind: 'launch'; launch: string }
  | { kind: 'step'; launch: string; step: CloudStepId; state: 'running' | 'done' | 'failed'; error?: string }
  | { kind: 'wake'; hostId: string; state: string; reason?: string }
  | { kind: 'gone' }
  | { kind: 'state'; hostId?: string }
  | { kind: 'stopping'; hostId: string; stopping: boolean };
/** A cloud machine's line (shared/cloud/cloudLine.mjs); null when none of the cloud states applies. */
/** `line` is empty when none of the cloud states applies (the ordinary line shows); `idle` is "Stops when idle · 30 min" for an online machine. */
export type CloudLine = { line: string; dot: 'off' | 'warn'; action: 'Remove' | 'Cancel' | 'Wake' | null; idle?: string } | null;
/** What Delete names first, and the token that confirms it. */
export type CloudDeletePlan = { chats: { chatId: string; title: string; folder: string | null }[]; token: string };
/** The provider's record of a cloud machine (the registry's `cloud`). */
export type CloudRecord = { provider: string; id: string; region: string; size: string; network: 'full' | 'limited' };

/** `auto` uses SSH when it is up and the relay otherwise; `ssh` and `relay` pin the machine to one path (no fallback). */
export type HostPathMode = 'auto' | 'ssh' | 'relay';
type HostWorktreeRequest = { key: string; repo: string; branch: string; from?: string; expectedHostKey?: string };
declare module '../native' {
  interface NativeApi {
    host: {
      /** whether Host exists for the signed-in account now */
      access(): Promise<boolean>;
      onAccess(cb: (allowed: boolean) => void): () => void;
      /** the remote machines, each with its dot and one-line note; `resolved` once every one has answered or failed (empty while Host is not available) */
      machines(): Promise<{
        machines: HostMachineRow[];
        resolved: boolean;
      }>;
      onMachines(cb: (list: { machines: HostMachineRow[]; resolved: boolean }) => void): () => void;
      /** A machine's removal committed, regardless of heartbeat or registry read failures for other devices. */
      onMachineRemoved(cb: (id: string) => void): () => void;
      /** install the Host on `user@host`, pair and check it; a machine that installed but did not pair is listed with `paired: false` and its reason in `error`; `daemonPassword`: a Mac's administrator password, to start its Host at boot (a Mac nobody is signed in on), sent to its sudo and never kept */
      add(
        destination: string,
        opts?: { daemonPassword?: string },
      ): Promise<{
        ok: boolean;
        paired: boolean;
        error: string;
        id: string;
        steps: HostInstallStep[];
        /** a failed add was undone on the machine; `cancelled`: it was stopped by cancelAdd */
        rolledBack?: boolean;
        cancelled?: boolean;
        /** this Mac's MoPilot key, when the machine takes keys only and none of this Mac's is authorized on it */
        publicKey?: string;
      }>;
      /** install this Mac's background Host for this macOS user and pair with it, with no code shown (host.local); refused while the flag is off */
      addLocal(): Promise<{
        ok: boolean;
        paired: boolean;
        error: string;
        id: string;
        steps: { id: string; label: string; state: string; output: string }[];
      }>;
      /** stop this Mac's background Host and delete its files */
      removeLocal(): Promise<void>;
      /** register this app with a listed machine using the code its Host printed */
      pair(id: string, code: string): Promise<void>;
      /** send this app's Host build to a paired machine, signed for that Host; it restarts into the build once idle. Refusals carry `code` (`unknown_machine`, `not_paired`, `update_failed`) */
      update(id: string): Promise<{ version: string; output: string }>;
      /** ask every machine for its status now (a row's Check again) */
      check(): Promise<void>;
      /** start the Host on a machine whose ssh answers and whose Host does not (its row says "Host is not running"); rejects with `code` `no_ssh`, `needs_admin` or `start_failed` and what to do */
      startHost(id: string): Promise<void>;
      /** the name the machine is shown by everywhere; rejects an empty or too long one with what to fix */
      rename(id: string, name: string): Promise<void>;
      /** Keep running after restart on a Mac added over SSH, with its administrator password (sent to the machine's sudo, never kept); rejects with `wrong_password`, `not_admin`, `unsupported`, `busy` or `boot_change_failed` */
      setStartAtBoot(id: string, on: boolean, password: string): Promise<void>;
      /** the command that turns it on, for a person to run at the machine instead */
      startAtBootCommand(id: string): Promise<string>;
      /** rotate this app's key across its machines: a new key is added to every machine, then the old one dropped; resolves with how many machines trust only the new key and those still to be told (told on the next call); rejects with `rotation_blocked` (a machine is offline, has no ssh or is out of date) or `rotation_failed`, nothing changed */
      rotateKey(): Promise<{ machines: number; pending: { id: string; error: string }[] }>;
      /** what Remove asks first: whether ssh answers (`reachable`, the Host may be stopped), whether the Host answers too (`online`), whether a turn runs there (`busy`), whether the Host is a boot daemon whose removal needs the administrator password, a Mac that never said whether it starts at boot (`unsure`) and the name of another row using the same Host (`shared`) */
      removePlan(id: string): Promise<{
        ssh: boolean;
        reachable: boolean;
        online: boolean;
        busy: 'yes' | 'no' | 'unknown';
        daemon: boolean;
        unsure: boolean;
        shared: string;
        /** `same`: that row has the same address or Host key; `unknown`: a Host key is missing, so the two cannot be told apart */
        why: '' | 'same' | 'unknown';
      }>;
      /** stop and uninstall the Host on the machine (running or not) and delete its files, then Remove forgets it; a boot daemon without `password` (`daemon`), a Mac that cannot say (`unsure`) and a Host another row uses (`shared`) are left. Rejects with `wrong_password`, `not_admin`, `uninstall_failed` or `uninstall_cut_off` (ssh dropped mid-way: the Host may be stopped and files may remain) */
      uninstall(
        id: string,
        password: string,
      ): Promise<{ left: '' | 'daemon' | 'unsure' | 'shared'; shared?: string; why?: 'same' | 'unknown' }>;
      remove(id: string): Promise<void>;
      pendingDeletions(): Promise<{ hostId: string; chatId: string }[]>;
      /** which Host holds the chat now (null while Host is not available) */
      owner(chatId: string): Promise<{ hostId: string; epoch: number } | null>;
      /** a picture the user sent to a chat on a machine, read back from it: its data URL, or why there is none */
      picture(chatId: string, url: string): Promise<HostPictureReply>;
      /** every chat that runs on a remote machine now, with the machine (none while Host is not available): one read for a whole list */
      remoteChats(): Promise<{ chatId: string; hostId: string }[]>;
      /** continue the chat on another machine in `cwd`; rejects with the refusal's `code` (harness_not_configured, directory_missing, continue_in_flight, turn_running, host_unreachable, …) and the chat stays where it was */
      continueChat(req: {
        chatId: string;
        targetHostId: string;
        cwd: string;
        lostHostConfirmed: boolean;
        /** carry the source's uncommitted changes to the folder; new files go only when `confirmed` and listed in `untracked`; `unpushed` is how many unpushed commits the user agreed to publish with them */
        carry?: { confirmed: boolean; untracked: string[]; unpushed: number };
      }): Promise<HostReply<{ hostId: string; epoch: number }>>;
      /** what the folder picked on the machine holds compared with the chat's repository, and what carrying the source's uncommitted changes would send (`plan` null: nothing to carry); null when there is nothing to read */
      /** the dialog was closed or cancelled before its continue started: the chat's messages kept for the move are released */
      planRelease(chatId: string): Promise<HostReply<void>>;
      codePlan(req: { chatId: string; targetHostId: string; cwd: string }): Promise<
        HostReply<{
          state: string;
          repository: string | null;
          branch: string | null;
          dirty: number;
          plan: { untracked: string[]; changed?: string[]; skipped: string[]; files: number; unpushed: number; remote: string } | null;
        } | null>
      >;
      /** the folders in `path` (default: the machine's first root) on a remote machine, inside what it shares; refusals carry `code` (`outside_roots`, `directory_missing`, …) */
      fsList(id: string, q: { path?: string; hidden?: boolean }): Promise<HostReply<HostListing>>;
      /** the files in `path` on a machine whose names match `query`, best first, paths relative to the folder (at most `limit`, 50 by default; `truncated` when more matched); refusals carry `code` (`outside_roots`, `directory_missing`, `host_outdated`, …) */
      fsSearch(id: string, q: { path: string; query: string; limit?: number }): Promise<HostReply<{ files: string[]; truncated: boolean }>>;
      /** the slash commands and skills an agent on a machine offers for a folder (`harness`: `claude`, `codex` or `acp:<agent>`); `listed: false` when the agent has none to give yet, `outdated` when the machine's Host cannot list them */
      commands(id: string, q: { harness: string; cwd?: string }): Promise<HostReply<HostCommandList>>;
      /** the branch and changes of the repository in `path` on a machine, read-only; refusals carry `code` (`outside_roots`, `directory_missing`, `read_timed_out`, `host_outdated`, …) */
      sidebarRepository(id: string, q: HostSidebarRepositoryQuery): Promise<HostReply<string | null>>;
      gitStatus(id: string, q: { path: string }): Promise<HostReply<HostGitStatus>>;
      /** the branches of the repository holding `path` on a machine, for the new-chat branch picker; refusals carry `code` (`outside_roots`, `directory_missing`, `read_timed_out`, `host_outdated`, …) */
      gitBranches(id: string, q: { path: string; expectedHostKey?: string }): Promise<HostReply<HostBranches>>;
      /** check out `branch` in `path` on a machine, where a new chat runs without a worktree; git's refusal is `ok: false` with a sentence (`refused`), refusals as for `gitBranches` */
      gitSwitch(id: string, q: { path: string; branch: string; expectedHostKey?: string }): Promise<HostReply<HostWriteResult>>;
      /** the patch of what changed in `path` on a machine (`uncommitted`: against HEAD, `branch`: against the base branch), read-only; refusals carry `code` (`outside_roots`, `read_timed_out`, `host_outdated`, …) */
      gitDiff(id: string, q: { path: string; scope: 'uncommitted' | 'branch' }): Promise<HostReply<HostDiff>>;
      /** what one turn of a chat changed in `path` on a machine (its Host takes a tree of the folder around each turn): no repository, no usable start of that turn (`baseline: false`), or the patch; an older Host answers `host_outdated` */
      gitTurnDiff(id: string, q: { path: string; turnId: string }): Promise<HostReply<HostTurnDiff>>;
      /** commit the changes in `path` on a machine: every change (`files` null) or only those files (paths relative to the folder), as this Mac's Changes pane does; refusals carry `code` (`outside_roots`, `not_a_repository`, `write_timed_out`, `audit_unavailable`, `host_outdated`, …) */
      gitCommit(
        id: string,
        q: {
          path: string;
          message: string;
          files: { path: string; oldPath?: string; isCopy?: boolean; isDeleted?: boolean }[] | null;
        },
      ): Promise<HostReply<HostWriteResult>>;
      /** discard the changes of one file in `path` on a machine, or of everything in it (`file` null), as this Mac's Changes pane does; refusals as for `gitCommit` */
      gitDiscard(id: string, q: { path: string; file: string | null }): Promise<HostReply<HostWriteResult>>;
      /** the files and folders in `path` on a machine, read-only; refusals carry `code` (`outside_roots`, `directory_missing`, `not_a_directory`, `read_timed_out`, `host_outdated`, …) */
      fsTree(id: string, q: { path: string }): Promise<HostReply<HostTree>>;
      /** the start of the file `path` on a machine (`limit`: the most bytes); refusals carry `code` (`not_a_file`, `outside_roots`, …) */
      fsRead(id: string, q: { path: string; limit?: number }): Promise<HostReply<HostFileView>>;
      /** clone `url` into `dest` on the machine (`useMacSignIn`: lend this Mac's sign-in for the address's host to this one clone; main reads it, the window never sees it); `key` names the attempt (progress comes with it, a repeat returns the first outcome) */
      clone(id: string, q: { key: string; url: string; dest: string; useMacSignIn?: boolean }): Promise<HostReply<HostPlace>>;
      /** a worktree of `repo` on `branch`, beside it on the machine; `from`: the branch a new `branch` starts from (the repository's HEAD when absent) */
      worktree(id: string, q: HostWorktreeRequest): Promise<HostReply<HostPlace>>;
      /** make a chat for a machine: its folder is recorded with the machine and the chat is listed; its first message starts it there. Rejects with the refusal's `code` (`unknown_machine`, `harness_not_configured`, …). */
      startChat(q: {
        chatId: string;
        hostId: string;
        folder: string;
        harness: string;
        projectId?: string | null;
        scope?: string;
      }): Promise<{ chatId: string }>;
      openSideChat(chatId: string, restoring?: string): Promise<HostSideChat | null>;
      /** record the chat's folder with its machine in the ownership side map */
      bindFolder(chatId: string, q: { hostId: string; folder: string }): Promise<void>;
      /** whether git can sign in to each repository host on the machine, read now from its Host (once per ask, never polled): `no` when its git has no credential, `unknown` when the machine cannot say */
      gitSignIn(id: string): Promise<Record<string, 'yes' | 'no' | 'unknown'>>;
      /** this Mac's loopback port that reaches `port` on the machine (a dev server the agent started there); refusals carry `code` (`unknown_machine`, `bad_port`, `forward_failed`) */
      forwardPort(id: string, port: number): Promise<{ localPort: number }>;
      /** how the app reaches the machine: `auto`, or pinned to `ssh` or `relay`; refusals carry `code` (`unknown_machine`, `bad_mode`) */
      setPath(id: string, mode: HostPathMode): Promise<void>;
      /** Add by command: a new one-line command for a machine the Mac cannot SSH to (any earlier one is ended); refusals carry `code` (`no_relay`); `retryJoin` instead repeats the join of an allowed machine that did not finish (state `join_failed`), keeping it listed */
      bootStart(retryJoin?: boolean): Promise<HostBootView>;
      /** how the command stands now */
      bootView(): Promise<HostBootView>;
      /** let the machine that ran the command join; resolves its id (it is listed at once and finishes joining in the background) */
      bootAllow(): Promise<{ id: string }>;
      /** do not let it join, or end the command: its credential is revoked */
      bootDeny(): Promise<void>;
      onBoot(cb: (view: HostBootView) => void): () => void;
      /** what each machine chat waits for, as its Host says (a chat with nothing is absent); changes arrive through onAttention */
      attentions(): Promise<Record<string, HostAttention>>;
      onAttention(cb: (e: { chatId: string; attention: HostAttention | null }) => void): () => void;
      onCloneProgress(cb: (p: { hostId: string; key: string; phase: string; percent: number }) => void): () => void;
      /** sign in to an agent on a machine, on the machine itself; resolves how the sign-in stands (a second call joins the one under way), and each change arrives through onSignin */
      signin(id: string, harness: string, recoveryKey?: string): Promise<HostSigninView>;
      /** Existing sign-ins, including attempts started before this window opened. */
      signinViews(): Promise<HostSigninView[]>;
      /** one line typed for the sign-in under way (the code its page asks for); false when none is, rejects with an older Host's refusal */
      signinInput(id: string, harness: string, text: string): Promise<boolean>;
      /** stop the sign-in; false when none was under way */
      cancelSignin(id: string, harness: string): Promise<boolean>;
      onSignin(cb: (view: HostSigninView) => void): () => void;
      /** the providers the user gave a key for, each as its last four characters (`…abcd`) */
      apiKeys(): Promise<Record<string, string>>;
      /** keep a key for the provider (encrypted on this Mac); resolves its hint, rejects with why it was not kept */
      setApiKey(provider: string, key: string): Promise<string>;
      /** forget the provider's key; false when none was kept */
      removeApiKey(provider: string): Promise<boolean>;
      /** the owner's rules for every machine (permission ceiling, approval timings, notifications): the document this Mac keeps and sends to each Host */
      ownerPolicy(): Promise<HostOwnerPolicy>;
      /** keep a new document (refused whole when invalid) and send it to every machine; a machine that is away gets it when it is next reached */
      setOwnerPolicy(
        doc: HostOwnerPolicy,
      ): Promise<{ doc: HostOwnerPolicy; machines: { id: string; ok: boolean; generation?: string; code?: string }[] }>;
      /** a machine's page: the clients its Host knows (a client's `id` is its fingerprint; `self` is this Mac) */
      clients(id: string): Promise<{ clients: { id: string; name: string; kind: string; addedAt: number | null; self: boolean }[] }>;
      /** take a client off the machine; its Host closes its connections at once */
      removeClient(id: string, clientId: string): Promise<unknown>;
      /** the last lines of the machine's audit record, newest first */
      audit(id: string): Promise<{ lines: { at: number; kind: string; who: string }[] }>;
      /** the Host's own status now (today's spend, the managed layer) */
      hostStatus(id: string): Promise<unknown>;
      /** the phones of a machine that may be offered direct access, and the owner's switch for one */
      phoneDirectList(id: string): Promise<{ pairId: string; fingerprint: string | null; state: 'off' | 'offered' | 'on' }[]>;
      phoneDirectSet(id: string, pairId: string, on: boolean): Promise<void>;
      /** forget the API keys and the organization sign-in here, and on every machine take the key and lease back and sign Claude Code and Codex out: each machine's result */
      signOutEverywhere(): Promise<HostSignOutResult[]>;
      /** organization access (#3361 Tier 2): the admin's settings and how the sign-in on this Mac stands; never a token */
      orgAccess(): Promise<HostOrgAccessView>;
      /** keep the admin's settings; changed ones end the sign-in and take every lease back. Rejects with what is wrong */
      setOrgAccess(config: HostOrgAccessConfig): Promise<HostOrgAccessView>;
      /** the admin removes organization access: every machine takes its lease back */
      removeOrgAccess(): Promise<HostOrgAccessView>;
      /** sign in to the organization in the system browser (a second call joins the first); messages that waited for it go after */
      orgSignIn(): Promise<HostOrgAccessView>;
      /** sign out of the organization here and at its IdP; every machine takes its lease back */
      orgSignOut(): Promise<HostOrgAccessView>;
      onOrgAccess(cb: (view: HostOrgAccessView) => void): () => void;
      /** move a chat on a machine to another agent there: the Host holds the choice and settles it with the chat's next message; rejects with the Host's reason (not installed, signed out, an older Host) */
      switchChat(
        chatId: string,
        pick: { harness: string; model?: string; effort?: string },
      ): Promise<{ pending: { harness: string; model?: string } | null }>;
      /** what the goal bar does to the goal of a chat on a machine, run by the chat's agent there; resolves the chat's goal after it, rejects with the Host's reason (the agent has no such action, an older Host, unreachable) */
      goalChat(
        chatId: string,
        what: { action: string; human?: boolean; tokens?: number | null; objective?: string },
      ): Promise<{ goal: ChatGoal | null }>;
      /** install a missing agent on a machine, on the machine itself; resolves how the install stands (a second call joins the one under way), and each change arrives through onAgentInstall */
      installAgent(id: string, harness: string): Promise<HostInstallView>;
      /** stop the install; false when none was under way */
      cancelInstallAgent(id: string, harness: string): Promise<boolean>;
      onAgentInstall(cb: (view: HostInstallView) => void): () => void;
      /** each install step as it starts and ends, for the Add machine card */
      onInstallStep(cb: (e: { destination: string; step: HostInstallStep }) => void): () => void;
      /** stop the add under way for `destination` and undo what it made (its add then resolves `cancelled`); false when none runs */
      cancelAdd(destination: string): Promise<boolean>;
      /** a question ssh asks while a machine is added (`prompt` null: it was answered or is gone) */
      onPrompt(cb: (e: { id: string; destination: string; prompt: HostSshPrompt | null }) => void): () => void;
      /** the answer to a question (null cancels it); false when it is no longer open. The answer goes to ssh only and is never kept. */
      answerPrompt(id: string, answer: string | null): Promise<boolean>;
      /** machines to offer in the Add machine picker (ssh config, this network over Bonjour, Tailscale peers); run only when it opens */
      discover(): Promise<HostFoundMachine[]>;
      /** whether ssh on the machine answers now (a Mac whose Remote Login was off) */
      reachable(destination: string): Promise<boolean>;
      /** cloud machines (host.cloud; every call is refused while it is off): the providers and whether a key is kept for each */
      cloudProviders(): Promise<CloudProvider[]>;
      /** keep a provider's key (its field values and `privateKeyPem`), encrypted on this Mac; never returned. Rejects with why it was not kept */
      cloudSetKey(provider: string, credential: Record<string, string>): Promise<{ ok: true }>;
      cloudRemoveKey(provider: string): Promise<boolean>;
      /** one read call with the kept key: "Checking the key…" */
      cloudCheck(provider: string, region?: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
      cloudOptions(provider: string, region?: string): Promise<CloudOptions>;
      /** create a machine; resolves when it has joined, rejects with `code` and `message` (its steps arrive through onCloud) */
      cloudLaunch(spec: {
        provider: string;
        name: string;
        size: string;
        region: string;
        network?: 'full' | 'limited';
      }): Promise<{ id: string; providerId: string }>;
      /** end a creation and delete what it made */
      cloudCancel(launch: string): Promise<unknown>;
      cloudWake(hostId: string): Promise<unknown>;
      /** Stop now: the provider stops the machine, disk kept */
      cloudStop(hostId: string): Promise<{ ok: true }>;
      cloudPlan(hostId: string): Promise<CloudDeletePlan>;
      /** delete the machine at the provider; `carry` names the chats whose unpushed work is pushed to a branch first */
      cloudDelete(hostId: string, o: { token: string; carry?: string[] }): Promise<unknown>;
      cloudLine(hostId: string): Promise<CloudLine>;
      onCloud(cb: (e: CloudEvent) => void): () => void;
    };
  }
}

/** The admin's organization access settings: nothing secret. */
export interface HostOrgAccessConfig {
  issuer: string;
  clientId: string;
  scopes?: string;
  /** how long a lease lives, 1 to 24 hours (default 8) */
  leaseHours?: number;
  access: { kind: 'gateway'; gateways: { anthropic?: string; openai?: string } };
}
export interface HostOrgAccessView {
  configured: boolean;
  config: (HostOrgAccessConfig & { leaseHours: number }) | null;
  state: 'off' | 'signedOut' | 'signedIn' | 'signinRequired';
  who: string | null;
  /** set while the organization's managed policy decides these settings: who manages them, and why its last change was not taken */
  managed: { organization: string; problem: string } | null;
}

/** The owner's policy document (shared/host/policy.mjs): what every Host enforces with this Mac away. */
export type HostOwnerPolicy = {
  version: 1;
  permissionMax: 'read-only' | 'default' | 'auto-review' | 'full-access';
  approvals: { remindMinutes: number; pauseMinutes: number };
  notify: {
    needsYou: boolean;
    done: boolean;
    paused: boolean;
    detail: 'minimal' | 'tool' | 'full';
    quiet: null | { start: string; end: string; tz: string };
  };
  [block: string]: unknown;
};
