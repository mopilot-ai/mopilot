// Codex hook feedback in the chat: meaningful failure/block reasons, with process telemetry kept quiet as in Claude Desktop.

/**
 * Outcomes that may carry Codex feedback. A hook that stopped the agent on purpose ('stopped') did its job;
 * Claude's user-facing notices arrive separately, rather than being inferred from execution outcomes.
 */
const SHOWN = new Set(['failed', 'blocked', 'cancelled']);
/** Lines a Node hook's runtime writes to stderr on its own (a MODULE_TYPELESS_PACKAGE_JSON warning and its advice). */
const RUNTIME_NOISE = /^(\(node:\d+\) |Reparsing as ES module|To eliminate this warning|\(Use `node --trace-)/;
/** A process exit alone carries no user-facing feedback (Claude Desktop does not render hook_response telemetry). */
const EXIT_ONLY = /^hook exited with (?:code|status) \d+[.!]?$/i;

/**
 * @param {{ event?: string | null, name?: string | null, outcome?: string | null, exitCode?: number | null, detail?: string | null }} run
 * @returns {string | null}
 */
export function hookRunNote({ outcome, detail }) {
  if (!SHOWN.has(outcome)) return null;
  const text = (typeof detail === 'string' ? detail : '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !RUNTIME_NOISE.test(l) && !EXIT_ONLY.test(l))
    .join('\n');
  // A blocked action still needs an explanation even when the hook supplied none.
  return text || (outcome === 'blocked' ? 'A hook blocked this action.' : null);
}

/** A Codex app-server hook run (hook/completed) as its turn's hookPrompt item, or null when hookRunNote shows nothing for it. */
export function codexHookItem(run) {
  if (!run) return null;
  const entries = Array.isArray(run.entries) ? run.entries : [];
  const detail = [
    ...entries.filter((e) => e?.kind === 'error').map((e) => e.text),
    run.statusMessage,
    ...entries.filter((e) => e?.kind !== 'error').map((e) => e?.text),
  ]
    .filter((s) => typeof s === 'string')
    .join('\n');
  const text = hookRunNote({ event: run.eventName, outcome: run.status, detail });
  return text ? { type: 'hookPrompt', id: `hook-${run.id}`, fragments: [{ text }] } : null;
}
