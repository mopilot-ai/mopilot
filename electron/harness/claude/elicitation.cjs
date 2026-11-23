// An MCP server asking the user for input through a Claude Code session (a form or a sign-in link): the card it raises, and
// the answer or cancel that goes back to the SDK. Unanswered, the SDK declines.
const { clock } = require('../../platform/ports/clock.cjs');

/**
 * @param {{ state: { emit: (event: object) => void }, lifetime: { active: (s: any) => boolean }, uuid: () => string,
 *           result: (answer: any) => object }} deps `result` turns the user's answer into the SDK's
 */
function createElicitation({ state, lifetime, uuid, result }) {
  return function requestElicitation(s, request, o) {
    if (!lifetime.active(s) || o?.signal?.aborted) return Promise.resolve({ action: 'cancel' });
    return new Promise((resolve) => {
      const requestId = `cperm-${uuid()}`;
      const finish = (response) => {
        o?.signal?.removeEventListener('abort', abort);
        resolve(response);
      };
      const abort = () => {
        if (!s.perms.delete(requestId)) return;
        finish({ action: 'cancel' });
        state.emit({ key: s.key, kind: 'permissionCancelled', requestId });
      };
      s.perms.set(requestId, (r) => finish(result(r)));
      s.lastActive = clock.now();
      o?.signal?.addEventListener('abort', abort, { once: true });
      state.emit({
        key: s.key,
        kind: 'elicitation',
        requestId,
        // the server's own id and permission display (its _meta['anthropic/permissionDisplay']), as the SDK gives them
        elicitationId: request.elicitationId ?? null,
        displayName: request.displayName ?? null,
        description: request.description ?? null,
        serverName: request.serverName,
        message: request.message,
        mode: request.mode ?? 'form',
        url: request.url ?? null,
        requestedSchema: request.requestedSchema ?? null,
        title: request.title ?? null,
      });
    });
  };
}

module.exports = { createElicitation };
