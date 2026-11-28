// A session rail connector row's action on the chat's current harness: sign in or reconnect, through each adapter's own call.
import { codexRequest, onCodexNotification } from '../../harness/adapters/codex';
import type { HarnessFamily } from '../../harness/family';
import { native } from '../../lib/native';

/** What a row's click does now: none on a harness that reports no live state or can't act on it. */
export type ConnectorAction = 'connect' | 'reconnect';

/**
 * Where a started sign-in stands. `browser`: the harness takes the browser's answer and reconnects the server itself, so
 * pressing the row again starts over. `finish`: the page has no callback to this app (a claude.ai connector), so the row
 * offers Reconnect once it is done. `none`: the server needed no sign-in after all.
 */
export type SignInStep = 'browser' | 'finish' | 'none';

const openable = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url);

/** Start a connector's sign-in for this session and open its page in the browser. */
export async function signInConnector(family: HarnessFamily, nativeId: string, name: string): Promise<SignInStep> {
  if (family === 'claude') {
    const answer = (await native.claude.control(nativeId, 'authenticateMcp', { name })) as {
      authUrl?: unknown;
      callbackExpected?: unknown;
    } | null;
    if (answer === null) throw new Error("This session's agent isn't running.");
    if (!openable(answer?.authUrl)) return 'none';
    await native.shell.openExternal(answer.authUrl);
    return answer.callbackExpected === true ? 'browser' : 'finish';
  }
  if (family === 'codex') {
    const answer = await codexRequest<{ authorizationUrl?: unknown } | null>('mcpServer/oauth/login', { name, threadId: nativeId });
    if (!openable(answer?.authorizationUrl)) throw new Error('The server did not provide a valid sign-in page.');
    await native.shell.openExternal(answer.authorizationUrl);
    return 'browser';
  }
  throw new Error("This harness can't sign in to a connector from here.");
}

/**
 * Reconnect a connector. Claude Code reconnects this session's server, after the running turn if there is one (`queued`);
 * Codex reloads its MCP servers, which every Codex chat shares.
 */
export async function reconnectConnector(family: HarnessFamily, nativeId: string, name: string): Promise<{ queued: boolean }> {
  if (family === 'claude') {
    const answer = (await native.claude.control(nativeId, 'reconnectMcp', { name, afterTurn: true })) as { queued?: unknown } | null;
    if (answer === null) throw new Error("This session's agent isn't running.");
    return { queued: answer?.queued === true };
  }
  if (family === 'codex') {
    await codexRequest('config/mcpServer/reload', undefined);
    return { queued: false };
  }
  throw new Error("This harness can't reconnect a connector from here.");
}

/** Claude Code reconnects held for the running turn (`waiting`) and those still running after it (`reconnecting`). */
export type HeldReconnects = { waiting: string[]; reconnecting: string[] };

const names = (list: unknown) => (Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []);

/** The reconnects main holds for this session, so a reopened or re-read rail still says so; other harnesses hold none. */
export async function heldReconnects(family: HarnessFamily, nativeId: string): Promise<HeldReconnects> {
  if (family !== 'claude') return { waiting: [], reconnecting: [] };
  const held = (await native.claude.control(nativeId, 'mcpQueued')) as { waiting?: unknown; reconnecting?: unknown } | null;
  return { waiting: names(held?.waiting), reconnecting: names(held?.reconnecting) };
}

/**
 * The end of a sign-in this rail started, where the harness reports one (Codex's mcpServer/oauthLogin/completed for this
 * thread, or one from settings, which names none): `error` says why it failed, null when it succeeded. Claude Code
 * reconnects the server itself, so its rows learn from the re-read instead.
 */
export function watchSignIns(
  family: HarnessFamily,
  nativeId: string,
  done: (name: string, error: string | null) => void,
): (() => void) | undefined {
  if (family !== 'codex') return undefined;
  return onCodexNotification((method, params) => {
    if (method !== 'mcpServer/oauthLogin/completed') return;
    const p = params as { name?: unknown; threadId?: unknown; success?: unknown; error?: unknown } | null;
    if (typeof p?.name !== 'string' || (p.threadId != null && p.threadId !== nativeId)) return;
    done(p.name, p.success === false ? (typeof p.error === 'string' ? p.error : 'the sign-in did not finish') : null);
  });
}
