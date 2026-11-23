// The fake CLI's remote_control request (below) and its rename_session control request (#1932): as the real CLI, it names its own session, appending the title
// line and writing Claude Code's custom-title.json beside the transcript, and refuses another session or a blank title.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * @param {{ transcript: string, sessionId: string, persist: boolean }} session
 * @param {{ title?: unknown, session_id?: string }} request
 */
export function renameSession({ transcript, sessionId, persist }, request) {
  if (request.session_id && request.session_id !== sessionId) throw new Error('rename_session: session_id is not the current session');
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  if (!title) throw new Error('rename_session: title must be a non-empty string');
  if (!persist) return {};
  const dir = path.dirname(transcript);
  fs.mkdirSync(path.join(dir, sessionId), { recursive: true });
  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`);
  fs.writeFileSync(path.join(dir, sessionId, 'custom-title.json'), JSON.stringify({ customTitle: title }));
  return {};
}

/** whether FAKE_CLAUDE_BRIDGE_DROPS has taken its one bridge down */
let bridgeDropped = false;

/**
 * The remote_control control request (SDK enableRemoteControl): a link while on, a refusal when FAKE_CLAUDE_NO_REMOTE_CONTROL
 * is set. Kept here with the other session-level requests so fake-claude.mjs stays within its size.
 * @param {{ enabled?: boolean }} request
 */
export function remoteControl(request) {
  if (process.env.FAKE_CLAUDE_NO_REMOTE_CONTROL) throw new Error('Remote Control is not available');
  if (!request.enabled) return {};
  // FAKE_CLAUDE_BRIDGE_DROPS: the first bridge is taken down by the CLI soon after it is up (a graceful teardown), as the real one does
  if (process.env.FAKE_CLAUDE_BRIDGE_DROPS && !bridgeDropped) {
    bridgeDropped = true;
    const drop = { type: 'system', subtype: 'worker_shutting_down', reason: 'worker_restart', uuid: randomUUID(), session_id: 'fake' };
    setTimeout(() => process.stdout.write(`${JSON.stringify(drop)}\n`), 400);
  }
  return {
    session_url: 'https://claude.ai/code/session_fake',
    connect_url: 'https://claude.ai/code?environment=',
    environment_id: '',
    bridge_epoch: 1,
    bridge_session_id: 'cse_fake',
  };
}
