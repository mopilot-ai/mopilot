// The seam for harness families on the Host. The shared ChatController takes one object per family (Codex: `codex`, Claude Code: `claudeTurns` and `claude`, ACP: `acpTurns`); a family this Host does not run gets the object made here, whose every call refuses with UnsupportedError, so the person sees "not available on this Host" and never a silent hang.
import { UnsupportedError } from './errors.mjs';

/** Methods the shared controller probes with `adapter?.method?.()` before every send: absent here, so the probe finds nothing instead of refusing a message that needs no such adapter. */
const OPTIONAL_PROBES = new Set(['pendingContinue', 'goalRestartCurrent']);

/**
 * An object that stands in for a family's adapter: any method called on it throws UnsupportedError naming the family.
 * It is not thenable and has no symbol members, so awaiting or inspecting it behaves like an ordinary object; the probes in OPTIONAL_PROBES are absent.
 * @param {string} name how the person knows what is missing ("Claude Code", "Codex")
 * @returns {any}
 */
export function unavailableFamily(name) {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === 'symbol' || key === 'then' || OPTIONAL_PROBES.has(key)) return undefined;
        return () => {
          throw new UnsupportedError(`${name} is not available on this Host.`);
        };
      },
    },
  );
}
