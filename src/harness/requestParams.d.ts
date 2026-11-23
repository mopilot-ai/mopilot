// The params of each approval card's request, by method: Codex's app-server requests as the protocol
// types them, and the Claude Code and basic-harness (ACP) requests as approvalRequests.ts builds them.
export type {
  AcpPermissionOption,
  AcpPermissionParams,
  AcpToolCall,
  ClaudeCommandParams,
  ClaudeElicitationParams,
  ClaudeFileChangeParams,
  ClaudeMeta,
  ClaudeQuestion,
  ClaudeQuestionParams,
  ClaudeRequestBase,
  ClaudeToolParams,
  CodexParams,
  RequestBody,
  RequestMethod,
  RequestParams,
} from '../../shared/model/requests';
