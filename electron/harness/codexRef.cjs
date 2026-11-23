// The Codex adapter's check before it talks to the app-server: the ref names a Codex segment with a bare thread id.
const { familyOf } = require('../session/contract/route.cjs');

/**
 * The rpc layer's check before it talks to Codex: the ref's kind is Codex and its id is a bare Codex
 * thread id. A 'claude:' or 'acp:' id here means a routing bug; it must fail instead of reaching Codex.
 */
function assertCodexRef(ref) {
  if (!ref || familyOf(ref.kind) !== 'codex') throw new Error(`Not a Codex session: ${ref?.kind}`);
  if (/^(claude|acp):/.test(String(ref.id))) throw new Error(`Refusing to send ${JSON.stringify(ref.id)} to Codex`);
  return ref;
}

module.exports = { assertCodexRef };
