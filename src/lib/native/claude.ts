// window.native.claude's types (the Claude Code harness in main), merged into NativeApi; the calls are declared in electron/bridge/claude.cjs.
import type {
  ClaudeAccountsEvent,
  ClaudeApiKeyInfo,
  ClaudeDesignLoginEvent,
  ClaudeDetect,
  ClaudeEvent,
  ClaudeSessionInfo,
  ClaudeSessionOpts,
} from '../native';
import type { ClaudeAccountsState, ClaudeCatalog, ClaudeModelInfo, ClaudeSlashCommand } from '../../../shared/model/native';
import type { ElsewhereApp } from '../../../shared/model/store';
import type { ClaudeMcpServer } from '../../../shared/model/native';
import type { PtySpawnOptions } from './contracts/platform';
import type { UsageReason } from '../../../shared/model/harness';
import type { UsageReadResult } from '../../../shared/model/native';

/** The Settings switch for Claude Code's Artifact tool (electron/harness/claude/artifacts.cjs): the user's choice, and whether it is switched off remotely. */
export type ClaudeArtifactsInfo = { on: boolean; killed: boolean };

declare module '../native' {
  interface NativeApi {
    claude: {
      detect(override?: string | null, force?: boolean, verify?: boolean, account?: string | null): Promise<ClaudeDetect>;
      apiKey(): Promise<ClaudeApiKeyInfo>;
      setApiKey(key: string, baseUrl?: string): Promise<ClaudeApiKeyInfo>;
      clearApiKey(): Promise<ClaudeApiKeyInfo>;
      /** `configId`: the model config, for 'routed' (Your own provider) */
      setAuthMode(mode: 'subscription' | 'apiKey' | 'mopilot' | 'routed', configId?: string): Promise<ClaudeApiKeyInfo>;
      /** pass the shell's cloud-provider variables (Bedrock, Vertex, Foundry) to Claude Code */
      setCloudEnv(on: boolean): Promise<ClaudeApiKeyInfo>;
      /** whether Claude Code may publish artifacts and designs to claude.ai (its Artifact tool); killed: switched off remotely */
      artifacts(): Promise<ClaudeArtifactsInfo>;
      setArtifacts(on: boolean): Promise<ClaudeArtifactsInfo>;
      /** whether every new Claude Code session is linked to Remote Control (claude.ai/code, the Claude app) */
      remoteControlDefault(): Promise<boolean>;
      setRemoteControlDefault(on: boolean): Promise<boolean>;
      probe(
        bin: string,
        account?: string | null,
      ): Promise<{
        models: ClaudeModelInfo[];
        account: { subscriptionType: string | null; apiProvider: string | null; email: string | null };
        fastBlocked: string | null;
      }>;
      /** follow a session another app is running: 'transcript' events on each write */
      watch(sessionId: string): Promise<boolean>;
      /** model (wire id) and effort the session last ran with */
      sessionSettings(sessionId: string): Promise<{ model: string; effort: string | null } | null>;
      /** `claude auth logout`, run in the background */
      logout(bin: string): Promise<void>;
      unwatch(sessionId: string): Promise<void>;
      /** `claude mcp add|remove …` (args start at `mcp`); resolves to the CLI's output */
      mcp(bin: string | null, args: string[], account?: string | null, cwd?: string, mode?: ClaudeApiKeyInfo['mode']): Promise<string>;
      mcpLoginCommand(bin: string | null, name: string, account: string, mode: ClaudeApiKeyInfo['mode']): Promise<PtySpawnOptions>;
      /** Claude Design's sign-in (`claude design-login --json`) on the account; its progress arrives on onDesignLogin under `id` */
      designLogin(id: string, bin: string | null, account?: string | null): Promise<void>;
      /** a code pasted from the sign-in page; false when that sign-in has ended */
      designLoginCode(id: string, code: string): Promise<boolean>;
      designLoginCancel(id: string): Promise<void>;
      onDesignLogin(cb: (e: ClaudeDesignLoginEvent) => void): () => void;
      /** skills/commands and MCP servers from the user's Claude settings */
      extras(
        bin: string,
        cwd?: string | null,
        account?: string | null,
      ): Promise<{ commands: ClaudeSlashCommand[]; mcp: ClaudeMcpServer[]; mcpError?: string }>;
      /** Claude's commands, skills and plugins for a folder and account (prefetched when no session ran there) */
      catalog(bin: string | null, cwd: string, account?: string | null): Promise<ClaudeCatalog>;
      onCatalog(cb: (e: { account: string; cwd: string; catalog: ClaudeCatalog }) => void): () => void;
      /**
       * The login's CLI usage output as of its last read (measuredAt: when the CLI fetched it) or a diagnostic error.
       * Main reads again only when `reason` finds it due (electron/identity/contract/usageRefresh.cjs); `cached`: no read ran.
       */
      usage(bin: string, account: string | null | undefined, reason: UsageReason): Promise<UsageReadResult>;
      accounts(): Promise<ClaudeAccountsState>;
      refreshAccounts(bin: string | null): Promise<ClaudeAccountsState>;
      /** creates the account and returns the terminal command that signs it in */
      addAccount(bin: string | null): Promise<{ state: ClaudeAccountsState; id: string; command: string[] }>;
      cancelAccountLogin(): Promise<ClaudeAccountsState>;
      reloginCommand(bin: string | null, id: string): Promise<string[]>;
      /** a sign-in for these logins ended: main reads their usage at once, whatever held it back */
      signInEnded(ids: string[]): Promise<void>;
      removeAccount(bin: string | null, id: string): Promise<ClaudeAccountsState>;
      setActiveAccount(id: string): Promise<ClaudeAccountsState>;
      setAccountAutoSwitch(on: boolean): Promise<ClaudeAccountsState>;
      onAccountsEvent(cb: (e: ClaudeAccountsEvent) => void): () => void;
      control(
        key: string,
        method:
          | 'interrupt'
          | 'setModel'
          | 'setPermissionMode'
          | 'applyFlagSettings'
          | 'stopTask'
          | 'stopAllTasks'
          | 'backgroundTasks'
          | 'contextUsage'
          | 'mcpStatus'
          | 'toggleMcp'
          | 'reconnectMcp'
          | 'remoteControl'
          | 'close',
        arg?: unknown,
      ): Promise<unknown>;
      permission(requestId: string, result: unknown): Promise<boolean>;
      /** sessions other apps' `claude` processes have open: session id → apps */
      presence(): Promise<Record<string, ElsewhereApp[]>>;
      list(opts?: { limit?: number; offset?: number }): Promise<ClaudeSessionInfo[]>;
      /** sessions whose title or transcript holds the term, newest first */
      /** `scope` names the search box asking: its next search replaces its scan still running, others' go on */
      search(term: string, limit?: number, scope?: string): Promise<ClaudeSessionInfo[]>;
      /**
       * A page of a session's turns built from its transcript, oldest first, as JSON to parse (`{ turns, olderCursor, closedTail }`):
       * the `limit` before the turn `before` (the latest without it, all without a limit), and the cursor for the page before
       * them (null at the start). `closedTail` also asks for a last turn left open for a live writer as it reads with none.
       * `diffs` are the saved diffs of those turns, by turn id.
       */
      turns(
        sessionId: string,
        opts: {
          chatId: string;
          cwd: string;
          liveTail?: boolean;
          closedTail?: boolean;
          open?: boolean;
          limit?: number;
          before?: string | null;
        },
      ): Promise<{ page: Uint8Array; diffs: Record<string, string> }>;
      /**
       * a sub-agent's stored transcript (the SDK's getSubagentMessages) as its agent page's items, JSON to parse
       * (`{ items, model, unread }`), searched in `dir` first; null when it left none there. A `settled` run's open tools were cut off
       */
      subagentItems(
        sessionId: string,
        agentId: string,
        opts: { chatId: string; cwd: string; settled: boolean; dir: string | null },
      ): Promise<Uint8Array | null>;
      /** the last 64 KB of a background task's output file (`…/tasks/<id>.output` only) */
      taskOutput(taskId: string, file: string): Promise<string>;
      info(sessionId: string): Promise<ClaudeSessionInfo | undefined>;
      /** session id → the session id of the Claude desktop chat that started it (nesting only, no family authority) */
      desktopLineage(): Promise<Record<string, { parentId: string; createdAt: number }>>;
      rename(sessionId: string, title: string): Promise<void>;
      /** delete a discardable fork no chat has taken yet (a fork left half made); main refuses any other session */
      discardFork(sessionId: string): Promise<void>;
      /**
       * turnUuid: the prompt that starts the turn to fork after (its last message is kept); none forks the whole chat.
       * discardable: the fork may go again with discardFork until a chat takes it (one part of a switched chat's fork)
       */
      fork(sessionId: string, turnUuid?: string | null, discardable?: boolean): Promise<{ sessionId: string }>;
      /** user messages with a file checkpoint → the chain entry before each (null for the first) */
      checkpoints(sessionId: string): Promise<Record<string, string | null>>;
      rewind(
        key: string,
        opts: ClaudeSessionOpts,
        uuid: string,
        dryRun: boolean,
      ): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[] }>;
      onEvent(cb: (e: ClaudeEvent) => void): () => void;
      /** a chat's items, as main translates its events (electron/harness/items/claude.cjs): Codex-shaped notifications */
      onItems(cb: (e: { chatId: string; key: string; method: string; params: Record<string, unknown> }) => void): () => void;
    };
  }
}
