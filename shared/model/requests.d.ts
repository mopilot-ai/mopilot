// What a harness asks the user, as types only: each request method and its params, the approvals main holds for a chat,
// a Claude tool call's input, and the questions a turn already answered.
import type { HarnessKind } from './harness';
import type { ServerRequest } from '../../src/protocol/ServerRequest';

/** A Codex app-server request's params, by method. */
export type CodexParams<M extends ServerRequest['method']> = Extract<ServerRequest, { method: M }>['params'];

/** What the Claude answer needs back from the request: the tool, its input and the CLI's suggestions. */
export type ClaudeMeta = {
  toolName: string;
  input: ClaudeToolInput | null | undefined;
  suggestions: unknown[] | null;
};

/** The fields every Claude Code permission card carries, in the Codex v2 approval's place. */
export type ClaudeRequestBase = {
  threadId: string;
  turnId: null;
  itemId: string | null;
  reason: string | null;
  _claude: ClaudeMeta;
};

/** A Claude Bash permission, as the command card reads it. */
export type ClaudeCommandParams = ClaudeRequestBase & { command: string; cwd: string | null };

/** A Claude file edit permission, as the edit card reads it. */
export type ClaudeFileChangeParams = ClaudeRequestBase & { grantRoot: string | null };

/** One AskUserQuestion question, in the Codex question card's shape. */
export type ClaudeQuestion = {
  id: string;
  header: string | null;
  question: string;
  options: { label: string; description?: string }[];
  isOther: boolean;
  isSecret: boolean;
  multiSelect: boolean;
};

/** Claude's AskUserQuestion, as the question card reads it. */
export type ClaudeQuestionParams = ClaudeRequestBase & { questions: ClaudeQuestion[] };

/** Any other Claude Code tool (WebFetch, MCP tools, Claude in Chrome, ExitPlanMode, ...). */
export type ClaudeToolParams = ClaudeRequestBase & {
  toolName: string | undefined;
  input: ClaudeToolInput | undefined;
  title: string | null | undefined;
  blockedPath: string | null | undefined;
};

/** An MCP server's elicitation through Claude Code, as the elicitation card reads it. */
export type ClaudeElicitationParams = {
  threadId: string;
  turnId: null;
  serverName: string | undefined;
  message: string | undefined;
  mode: string | undefined;
  url: string | null | undefined;
  requestedSchema: unknown;
  _claude: ClaudeMeta;
};

/** A basic harness's tool call, as far as the permission card reads it (ACP ToolCallUpdate). */
export type AcpToolCall = {
  toolCallId?: string;
  title?: string | null;
  kind?: string | null;
  rawInput?: unknown;
} & Record<string, unknown>;

/** One of the answers an ACP session/request_permission offers. */
export type AcpPermissionOption = { optionId: string; name: string; kind: string };

/** A basic harness's session/request_permission. */
export type AcpPermissionParams = {
  threadId: string;
  turnId: null;
  toolCall: AcpToolCall | null;
  options: AcpPermissionOption[];
};

/**
 * Each card request's params by method. The Codex methods are the ones main forwards to the window
 * (RENDERER_METHODS in electron/capabilities/contract/serverRequests.cjs); a Claude Code request takes the Codex
 * card it maps to, so several methods have both shapes.
 */
export type RequestParams = {
  'item/commandExecution/requestApproval': CodexParams<'item/commandExecution/requestApproval'> | ClaudeCommandParams;
  'item/fileChange/requestApproval': CodexParams<'item/fileChange/requestApproval'> | ClaudeFileChangeParams;
  'item/permissions/requestApproval': CodexParams<'item/permissions/requestApproval'>;
  'item/tool/requestUserInput': CodexParams<'item/tool/requestUserInput'> | ClaudeQuestionParams;
  'mcpServer/elicitation/request': CodexParams<'mcpServer/elicitation/request'> | ClaudeElicitationParams;
  execCommandApproval: CodexParams<'execCommandApproval'>;
  applyPatchApproval: CodexParams<'applyPatchApproval'>;
  'claude/toolApproval': ClaudeToolParams;
  'acp/permission': AcpPermissionParams;
};

export type RequestMethod = keyof RequestParams;

/** A request's method with its params: one variant per method, so checking the method narrows the params. */
export type RequestBody<M extends RequestMethod = RequestMethod> = { [K in M]: { method: K; params: RequestParams[K] } }[M] & {
  sourceHarness?: HarnessKind | null;
};

export interface SessionApproval {
  /** Display identity published by main; private answer routing stays in the controller. */
  sourceHarness?: HarnessKind | null;
  id: number | string;
  method: string;
  /** ApprovalParams for the requests read here; anything else passes through */
  params: unknown;
}

/** The tool input a Claude approval was asked about (AskUserQuestion's questions are read). */
export type ClaudeToolInput = { questions?: { question: string }[] } & Record<string, unknown>;

/** One question as the transcript's answered-questions card shows it; a null answer is a skipped (or dismissed) question. */
export interface AnsweredQuestion {
  question: string;
  answer: string | null;
  /** the whole card was dismissed (Esc, or its X): the agent was told to stop and wait */
  dismissed?: boolean;
}
