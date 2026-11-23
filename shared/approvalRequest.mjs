// An approval main holds (SessionState `approvals`, electron/session/controllerEvents.cjs) as the request its card is built from, on every harness: the window's cards (src/harness/approvalRequests.ts) and Chrome's side panel (electron/capabilities/browser/chromePanelCards.cjs) read the same one.
//
// Main stores each harness's request as it came: Claude Code's as `claude/permission`, a basic harness's as
// `acp/permission`, Codex's under its app-server method. A card reads Codex's shapes, so Claude Code's tools become
// Codex's command, file-edit and question requests (or `claude/toolApproval`), carrying in `_claude` what the answer
// needs back (shared/claudeAnswer.mjs). Anything else (Codex's requests, MoPilot's own `sage/` cards) passes through.

/**
 * @param {{ method: string, params?: unknown }} a the approval as main holds it
 * @param {string | null} threadId the chat it is in
 * @param {string | null} cwd the chat's folder (a command card shows it)
 * @returns {{ method: string, params: any }}
 */
export function approvalRequest(a, threadId, cwd) {
  /** @type {any} */
  const p = a.params ?? {};
  switch (a.method) {
    case 'sage/remotePair':
      // a phone being paired: the name it gave itself and the number both screens show, nothing else the card was raised with
      return {
        method: a.method,
        params: {
          kind: 'remotePair',
          remotePair: { deviceName: String(p.remotePair?.deviceName ?? ''), safetyNumber: String(p.remotePair?.safetyNumber ?? '') },
        },
      };
    case 'claude/permission': {
      const meta = { toolName: p.toolName, input: p.input, suggestions: p.suggestions ?? null };
      const base = {
        threadId,
        turnId: null,
        itemId: p.toolUseID ?? null,
        reason: p.description ?? p.decisionReason ?? null,
        _claude: meta,
      };
      switch (p.toolName) {
        case 'Bash':
          return { method: 'item/commandExecution/requestApproval', params: { ...base, command: p.input?.command ?? '', cwd } };
        case 'Edit':
        case 'MultiEdit':
        case 'Write':
        case 'NotebookEdit':
          return { method: 'item/fileChange/requestApproval', params: { ...base, grantRoot: p.blockedPath ?? null } };
        case 'AskUserQuestion':
          return {
            method: 'item/tool/requestUserInput',
            params: {
              ...base,
              questions: (p.input?.questions ?? []).map((/** @type {any} */ q, /** @type {number} */ i) => ({
                id: String(i),
                header: q.header ?? null,
                question: q.question,
                options: q.options ?? [],
                isOther: true,
                isSecret: false,
                multiSelect: !!q.multiSelect,
              })),
            },
          };
        default:
          return {
            method: 'claude/toolApproval',
            params: { ...base, toolName: p.toolName, input: p.input, title: p.title, blockedPath: p.blockedPath },
          };
      }
    }
    case 'acp/permission':
      return { method: 'acp/permission', params: { threadId, turnId: null, toolCall: p.toolCall ?? null, options: p.options ?? [] } };
    case 'mcpServer/elicitation/request':
      // Claude's carries what its answer needs; a Codex one is passed through as it came (below)
      if (p.claude)
        return {
          method: 'mcpServer/elicitation/request',
          params: {
            threadId,
            turnId: null,
            serverName: p.serverName,
            message: p.message,
            mode: p.mode,
            url: p.url,
            requestedSchema: p.requestedSchema,
            _claude: { toolName: '', input: null, suggestions: null },
          },
        };
  }
  // A Codex app-server request, as main forwards it (RENDERER_METHODS in electron/capabilities/contract/serverRequests.cjs), or
  // one of MoPilot's own: its method names its params' type.
  return { method: a.method, params: p };
}
