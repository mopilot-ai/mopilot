// What a window asks Codex for, by name and typed: accounts, models, threads, projects, feedback, the
// import from other tools. Each call is a method of the Codex adapter in main (electron/harness/codex.cjs,
// `CODEX_API`), which sends the app-server request and takes a chat's thread from its NativeRef. The
// store and the harness modules call these instead of naming app-server methods; the generic
// `codexRequest` is left for the pages that belong to Codex (plugins, settings).
import { native } from '../../lib/native';
import { codexLeftIdle } from './codex';
import type { ExternalAgentConfigDetectResponse } from '../../protocol/v2/ExternalAgentConfigDetectResponse';
import type { ExternalAgentConfigMigrationItem } from '../../protocol/v2/ExternalAgentConfigMigrationItem';
import type { FeedbackUploadParams } from '../../protocol/v2/FeedbackUploadParams';
import type { GetAccountRateLimitsResponse } from '../../protocol/v2/GetAccountRateLimitsResponse';
import type { GetAccountResponse } from '../../protocol/v2/GetAccountResponse';
import type { LoginAccountResponse } from '../../protocol/v2/LoginAccountResponse';
import type { CancelLoginAccountResponse } from '../../protocol/v2/CancelLoginAccountResponse';
import type { ListMcpServerStatusResponse } from '../../protocol/v2/ListMcpServerStatusResponse';
import type { ThreadUnarchiveResponse } from '../../protocol/v2/ThreadUnarchiveResponse';
import type { ModelListResponse } from '../../protocol/v2/ModelListResponse';
import type { PluginListResponse } from '../../protocol/v2/PluginListResponse';
import type { ProjectCreateResponse } from '../../protocol/v2/ProjectCreateResponse';
import type { ProjectListResponse } from '../../protocol/v2/ProjectListResponse';
import type { SkillsListResponse } from '../../protocol/v2/SkillsListResponse';
import type { ThreadBackgroundTerminalsListResponse } from '../../protocol/v2/ThreadBackgroundTerminalsListResponse';
import type { ThreadGoalGetResponse } from '../../protocol/v2/ThreadGoalGetResponse';
import type { ThreadListParams } from '../../protocol/v2/ThreadListParams';
import type { ThreadListResponse } from '../../protocol/v2/ThreadListResponse';
import type { ThreadReadResponse } from '../../protocol/v2/ThreadReadResponse';
import type { ThreadAttachmentListResponse } from '../../protocol/v2/ThreadAttachmentListResponse';
import type { ThreadSearchResponse } from '../../protocol/v2/ThreadSearchResponse';
import type { ThreadTurnsListParams } from '../../protocol/v2/ThreadTurnsListParams';
import type { ThreadTurnsListResponse } from '../../protocol/v2/ThreadTurnsListResponse';
import type { ConfigReadResponse } from '../../protocol/v2/ConfigReadResponse';
import type { ConfigRequirementsReadResponse } from '../../protocol/v2/ConfigRequirementsReadResponse';
import type { ExternalAgentConfigImportResponse } from '../../protocol/v2/ExternalAgentConfigImportResponse';

/** The main app-server's Remote Control link to the user's devices (electron/harness/codexRemoteControl.cjs): the computer's, not a chat's. */
export interface CodexRemoteControlView {
  status: 'disabled' | 'connecting' | 'connected' | 'errored';
  environmentId: string | null;
  /** why the last attempt failed, in words for the user */
  error: string | null;
  /** the app-server's own last words about a failed attempt (shortened, nothing secret) */
  detail?: string | null;
  /** it was asked to connect and keeps trying again on its own */
  retrying?: boolean;
}

/** A device paired with this computer's Remote Control. */
export interface CodexRemoteControlClient {
  clientId: string;
  name: string | null;
  platform: string | null;
  /** seconds since the epoch; null: never seen */
  lastSeenAt: number | null;
}

export interface CodexApi {
  accountRead(): Promise<GetAccountResponse>;
  accountRateLimits(): Promise<GetAccountRateLimitsResponse>;
  /** ChatGPT sign-in: the response carries the URL to open. */
  loginChatgpt(): Promise<Extract<LoginAccountResponse, { type: 'chatgpt' }>>;
  /** Stop waiting for a ChatGPT sign-in. */
  loginCancel(loginId: string): Promise<CancelLoginAccountResponse>;
  logout(): Promise<unknown>;
  modelList(): Promise<ModelListResponse>;
  configRead(): Promise<ConfigReadResponse>;
  configRequirementsRead(): Promise<ConfigRequirementsReadResponse>;
  /** A page of threads: limit, cursor, sortKey, archived, searchTerm (titles). */
  threadList(p?: ThreadListParams): Promise<ThreadListResponse>;
  /** Threads whose content matches. */
  threadSearch(term: string, limit?: number): Promise<ThreadSearchResponse>;
  threadRead(threadId: string): Promise<ThreadReadResponse>;
  threadAttachments(threadId: string, cursor?: string | null): Promise<ThreadAttachmentListResponse>;
  threadTurns(threadId: string, p?: Omit<ThreadTurnsListParams, 'threadId'>): Promise<ThreadTurnsListResponse>;
  threadRename(threadId: string, name: string): Promise<unknown>;
  threadArchive(threadId: string): Promise<unknown>;
  threadUnarchive(threadId: string): Promise<ThreadUnarchiveResponse>;
  /** The goal of the chat's Codex thread. */
  threadGoal(chatId: string): Promise<ThreadGoalGetResponse>;
  /** Commands the chat's Codex thread left running in the background. */
  backgroundTerminals(chatId: string): Promise<ThreadBackgroundTerminalsListResponse>;
  /** Interrupt a turn on a thread by its own id (a sub-agent's child thread). */
  turnInterrupt(threadId: string, turnId: string): Promise<unknown>;
  projectList(): Promise<ProjectListResponse>;
  projectCreate(name: string, path: string): Promise<ProjectCreateResponse>;
  projectUpdate(projectId: string, name: string): Promise<unknown>;
  projectDelete(projectId: string): Promise<unknown>;
  projectMove(projectId: string, beforeProjectId: string | null): Promise<unknown>;
  feedbackUpload(p: Pick<FeedbackUploadParams, 'classification' | 'reason' | 'threadId' | 'includeLogs'>): Promise<unknown>;
  externalConfigDetect(cwds: string[]): Promise<ExternalAgentConfigDetectResponse>;
  externalConfigImport(items: ExternalAgentConfigMigrationItem[]): Promise<ExternalAgentConfigImportResponse>;
  /** The MCP servers Codex has and how they are doing. */
  mcpStatus(): Promise<ListMcpServerStatusResponse>;
  pluginList(): Promise<PluginListResponse>;
  skillList(cwd: string, forceReload?: boolean): Promise<SkillsListResponse>;
  /** The Remote Control link now (read from the app-server once per process, then kept by its notifications). */
  remoteControlRead(): Promise<CodexRemoteControlView>;
  /** Turn the link on or off; answers the state after. Never persisted: it ends with the app-server process. */
  remoteControlSet(on: boolean): Promise<CodexRemoteControlView>;
  /** A code a device types to pair, and when it ends (seconds since the epoch). The link must be up. */
  remoteControlPairing(): Promise<{ code: string | null; expiresAt: number }>;
  /** Whether a device has used that code. */
  remoteControlClaimed(code: string): Promise<boolean>;
  /** The devices paired, most recently seen first. */
  remoteControlClients(): Promise<CodexRemoteControlClient[]>;
  /** Take a device's access away. */
  remoteControlRevoke(clientId: string): Promise<void>;
}

function call<K extends keyof CodexApi>(name: K, args: Parameters<CodexApi[K]>): ReturnType<CodexApi[K]> {
  if (codexLeftIdle()) return Promise.reject(new Error("Codex isn't started")) as ReturnType<CodexApi[K]>;
  return native.codex.api(name, args) as ReturnType<CodexApi[K]>;
}

const method = <K extends keyof CodexApi>(name: K) => ((...args: Parameters<CodexApi[K]>) => call(name, args)) as CodexApi[K];

export const codexApi: CodexApi = {
  accountRead: method('accountRead'),
  accountRateLimits: method('accountRateLimits'),
  loginChatgpt: method('loginChatgpt'),
  loginCancel: method('loginCancel'),
  logout: method('logout'),
  modelList: method('modelList'),
  configRead: method('configRead'),
  configRequirementsRead: method('configRequirementsRead'),
  threadList: method('threadList'),
  threadSearch: method('threadSearch'),
  threadRead: method('threadRead'),
  threadAttachments: method('threadAttachments'),
  threadTurns: method('threadTurns'),
  threadRename: method('threadRename'),
  threadArchive: method('threadArchive'),
  threadUnarchive: method('threadUnarchive'),
  threadGoal: method('threadGoal'),
  backgroundTerminals: method('backgroundTerminals'),
  turnInterrupt: method('turnInterrupt'),
  projectList: method('projectList'),
  projectCreate: method('projectCreate'),
  projectUpdate: method('projectUpdate'),
  projectDelete: method('projectDelete'),
  projectMove: method('projectMove'),
  feedbackUpload: method('feedbackUpload'),
  externalConfigDetect: method('externalConfigDetect'),
  externalConfigImport: method('externalConfigImport'),
  mcpStatus: method('mcpStatus'),
  pluginList: method('pluginList'),
  skillList: method('skillList'),
  remoteControlRead: method('remoteControlRead'),
  remoteControlSet: method('remoteControlSet'),
  remoteControlPairing: method('remoteControlPairing'),
  remoteControlClaimed: method('remoteControlClaimed'),
  remoteControlClients: method('remoteControlClients'),
  remoteControlRevoke: method('remoteControlRevoke'),
};
