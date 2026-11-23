// The models Claude Code offers on this Host, for the `claude` entry of `host.status`: the CLI is asked once (the harness's probe, which starts it without a prompt and costs no tokens), the answer is kept, and a status never waits for it. A failed or empty ask is retried after a pause and the last good list stays.

import { claudeResolvedName, defaultEffort } from '../../shared/host/agentOptions.mjs';

/** How long a good list is kept before the CLI is asked again. */
const TTL_MS = 10 * 60_000;
/** How long after a failed or empty ask the next one waits (the CLI may be missing or signed out). */
const RETRY_MS = 60_000;

const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : null);

/**
 * The models the CLI offers in the shape Codex's entry has (`{ id, name, default, efforts }`), so the app's picker reads one shape: `default` is the CLI's recommended model (`default`), `efforts` the effort levels it takes.
 * `description` and `supportsAutoMode` ride along for the picker. A model without an id is none.
 * The option fields (#4935) come from the same answer: `resolvedModel` is the display name with its version (from the description, else the pinned id; absent when neither says one), `resolvedId` the pinned id the CLI reports, `defaultEffort` the level the agent runs at when none is chosen (the shared rule), `supportsFastMode` the CLI's flag.
 * @param {unknown} list the `models` of the CLI's initialization result
 * @returns {{ id: string, name: string, default: boolean, efforts: string[], defaultEffort: string | null, resolvedModel?: string, resolvedId?: string, supportsFastMode?: boolean, description?: string, supportsAutoMode?: boolean }[]}
 */
export function pickModels(list) {
  return (Array.isArray(list) ? list : []).flatMap((m) => {
    const id = str(m?.value);
    if (!id) return [];
    const efforts = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((/** @type {unknown} */ l) => str(l)) : [];
    const resolvedId = str(m.resolvedModel);
    const resolvedModel = claudeResolvedName({ value: id, description: m.description, resolvedId });
    return [
      {
        id,
        name: str(m.displayName) ?? id,
        default: id === 'default',
        efforts,
        defaultEffort: defaultEffort(efforts, m.defaultEffort),
        ...(resolvedModel ? { resolvedModel } : {}),
        ...(resolvedId ? { resolvedId } : {}),
        ...(typeof m.supportsFastMode === 'boolean' ? { supportsFastMode: m.supportsFastMode } : {}),
        ...(str(m.description) ? { description: m.description } : {}),
        ...(typeof m.supportsAutoMode === 'boolean' ? { supportsAutoMode: m.supportsAutoMode } : {}),
      },
    ];
  });
}

/**
 * @param {object} o
 * @param {() => Promise<ReturnType<typeof pickModels>>} o.ask the models the CLI offers right now (an empty list: none known)
 * @param {() => number} [o.now]
 * @param {(error: unknown) => void} o.report where an ask that fails goes
 */
export function createModelCache({ ask, now = Date.now, report }) {
  /** @type {ReturnType<typeof pickModels>} */
  let models = [];
  let keptAt = Number.NEGATIVE_INFINITY;
  let retryAt = 0;
  /** @type {Promise<void> | null} */
  let pending = null;
  /** Whether the first ask has ended, whatever it found. */
  let first = false;

  function refresh() {
    pending = (async () => {
      try {
        const found = await ask();
        if (found.length) {
          models = found;
          keptAt = now();
        } else retryAt = now() + RETRY_MS;
      } catch (error) {
        retryAt = now() + RETRY_MS;
        report(error);
      } finally {
        pending = null;
        first = true;
      }
    })();
  }

  return {
    /** The list kept so far (empty before the first ask has answered); an ask starts in the background when the list is old and none is under way. */
    get() {
      const at = now();
      if (!pending && at - keptAt >= TTL_MS && at >= retryAt) refresh();
      return models;
    },
    /** Whether the first ask is under way, so there is no answer yet: a later refresh or a retry is not (the list kept so far stands). */
    asking: () => pending !== null && !first,
    /** Resolves when the ask under way has ended. */
    settled: () => pending ?? Promise.resolve(),
  };
}
