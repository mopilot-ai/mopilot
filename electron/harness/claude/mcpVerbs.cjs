// A Claude Code session's connector sign-in and reconnect: sign-in asks the CLI for the page to open (it listens for the
// callback and reconnects the server itself), and a reconnect asked during a turn waits for the turn's end, as Claude Desktop's.

/**
 * The CLI's answer to mcp_authenticate, kept to what the rail uses. `authUrl` is absent when no sign-in is needed.
 * @param {any} answer
 * @returns {{ authUrl?: string, callbackExpected: boolean }}
 */
function signInAnswer(answer) {
  const url = typeof answer?.authUrl === 'string' && URL.canParse(answer.authUrl) ? new URL(answer.authUrl) : null;
  if (url && url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Claude Code returned a sign-in page MoPilot cannot open.');
  // a sign-in the CLI says needs the user, without a page to open, is not "nothing to do"
  if (!url && (answer?.requiresUserAction === true || answer?.callbackExpected === true))
    throw new Error('Claude Code did not return a sign-in page.');
  return { ...(url && { authUrl: url.href }), callbackExpected: answer?.callbackExpected === true };
}

/**
 * Start a server's sign-in. Without a redirect URI the CLI serves the OAuth callback on localhost and reconnects the
 * server when the browser returns; a claude.ai connector's page answers with no callback, so its row offers Reconnect.
 * @param {{ q: any }} s
 * @param {string} name
 */
async function authenticate(s, name) {
  if (typeof s.q?.mcpAuthenticate !== 'function') throw new Error('This Claude Code version cannot sign in to a connector from here.');
  return signInAnswer(await s.q.mcpAuthenticate(name));
}

/**
 * Reconnect now, or, when the rail asks (`afterTurn`), after the running turn so its tool calls keep their server. The
 * agent's own reconnect tool runs inside the turn and wants the server back for it, so it reconnects now.
 * @param {{ q: any, busy?: boolean, mcpQueued?: Set<string> }} s
 * @param {string} name
 * @param {boolean} [afterTurn]
 * @returns {Promise<{ queued: boolean }>}
 */
async function reconnect(s, name, afterTurn = false) {
  if (afterTurn && s.busy) {
    s.mcpQueued ??= new Set();
    s.mcpQueued.add(name);
    return { queued: true };
  }
  await s.q.reconnectMcpServer(name);
  return { queued: false };
}

/**
 * Run the reconnects that waited for the turn that just ended, or for the CLI to say it is idle (a turn can end without a
 * result of its own, readOnlyBoundary.cjs). Each stays listed as reconnecting until it settles; `changed` then says so, so
 * the rail reads the server's new status.
 * @param {{ q: any, busy?: boolean, mcpQueued?: Set<string>, mcpReconnecting?: Set<string> }} s
 * @param {{ idle?: boolean, ignored: (what: string, error: unknown) => void, changed: () => void }} o
 */
function afterTurn(s, { idle = false, ignored, changed }) {
  if ((s.busy && !idle) || !s.mcpQueued?.size) return;
  const names = [...s.mcpQueued];
  s.mcpQueued.clear();
  s.mcpReconnecting ??= new Set();
  for (const name of names) {
    s.mcpReconnecting.add(name);
    Promise.resolve()
      .then(() => s.q.reconnectMcpServer(name))
      .catch((error) => ignored('reconnect a Claude Code connector after its turn', error))
      .finally(() => {
        s.mcpReconnecting?.delete(name);
        changed();
      });
  }
}

/**
 * The servers whose reconnect waits for the running turn, and those whose reconnect after it is still running.
 * @param {{ mcpQueued?: Set<string>, mcpReconnecting?: Set<string> }} s
 */
const queued = (s) => ({ waiting: [...(s.mcpQueued ?? [])], reconnecting: [...(s.mcpReconnecting ?? [])] });

/**
 * After each message of the process: a turn's last result, or the CLI saying it is idle (not a subagent's), ends the wait.
 * @param {{ q: any, busy?: boolean, mcpQueued?: Set<string>, mcpReconnecting?: Set<string> }} s
 * @param {any} msg
 * @param {{ ignored: (what: string, error: unknown) => void, changed: () => void }} o
 */
function onMessage(s, msg, o) {
  const idle = msg.type === 'system' && msg.subtype === 'session_state_changed' && msg.state === 'idle' && !msg.parent_tool_use_id;
  if (idle || msg.type === 'result') afterTurn(s, { ...o, idle });
}

/**
 * The session control's MCP requests. `current` refuses an answer from a process the chat no longer runs on.
 * @param {any} s
 * @param {string} method
 * @param {any} arg
 * @param {(value: any) => any} current
 */
function control(s, method, arg, current) {
  const name = String(arg?.name);
  switch (method) {
    case 'mcpStatus':
      return s.q.mcpServerStatus().then(current);
    case 'toggleMcp':
      return s.q.toggleMcpServer(name, !!arg?.enabled);
    case 'reconnectMcp':
      return reconnect(s, name, arg?.afterTurn === true).then(current);
    case 'authenticateMcp':
      return authenticate(s, name).then(current);
    case 'mcpQueued':
      return queued(s);
    default:
      throw new Error(`Unknown control ${method}`);
  }
}

module.exports = { authenticate, reconnect, afterTurn, queued, signInAnswer, onMessage, control };
