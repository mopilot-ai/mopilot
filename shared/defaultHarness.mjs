// The default harness for new chats as one saved value ('codex', 'claude' or 'acp:<id>'), and the one-time move
// from the two prefs it replaced (`harness` and `basicHarness`). Pure: main migrates ui-state.json with it before
// any window opens (electron/platform/chats.cjs), and the renderer validates what it loads (src/store/types.ts).

/** A basic-tier harness by id: 'acp:<harness id>' (scheduled tasks store theirs the same way). */
const ACP_KIND = /^acp:[a-z0-9][a-z0-9_-]*$/;
/** The first-tier harnesses, named by id. */
const FIRST_TIER = new Set(['codex', 'claude']);

/** Whether `v` names a harness: 'codex', 'claude' or 'acp:<id>'. */
export const isHarnessKind = (v) => FIRST_TIER.has(v) || (typeof v === 'string' && ACP_KIND.test(v));

/** The two prefs `defaultHarness` replaced; nothing reads them but the migration below. */
export const RETIRED_DEFAULT_HARNESS_PREFS = ['harness', 'basicHarness'];

/**
 * What to write into saved prefs that still use the old two fields, or null when there is nothing to do. A basic
 * harness picked for new chats (`basicHarness`) overrode `harness`, so it becomes the default; otherwise `harness`
 * does when it names Codex or Claude Code, and Codex otherwise. A `defaultHarness` already saved wins, and the old fields go.
 * @param {unknown} prefs
 * @returns {{ set: Record<string, string>, unset: string[] } | null}
 */
export function defaultHarnessPatch(prefs) {
  const p = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? /** @type {Record<string, unknown>} */ (prefs) : {};
  const unset = RETIRED_DEFAULT_HARNESS_PREFS.filter((k) => Object.hasOwn(p, k));
  if (!unset.length) return null;
  if (isHarnessKind(p.defaultHarness)) return { set: {}, unset };
  const basic = typeof p.basicHarness === 'string' ? `acp:${p.basicHarness}` : null;
  const kind = basic && isHarnessKind(basic) ? basic : FIRST_TIER.has(p.harness) ? p.harness : 'codex';
  return { set: { defaultHarness: kind }, unset };
}
