// Every harness the Mac knows, usable or not, for a phone's agent list: its state, why not, and whether a chat can move to it from its next message (harnesses.list with `states`).

/** Admission's words for a basic harness's state, as the phone shows them; any other is still being checked. */
const ADMISSION_STATE = { admitted: 'ready', signin: 'signin', missing: 'missing', off: 'off' };

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services: acpAdmission
 * @param {Record<string, string>} o.labels the built-in harnesses' names by id
 * @param {(id: string) => Promise<boolean>} o.usable whether a harness can take a chat now
 * @param {(id: string) => Promise<string | null>} o.blocker why a chat can't move to a harness (chromePanelOptions.cjs switchBlocker), or null
 * @returns {() => Promise<object[]>}
 */
function createHarnessStates({ live, labels, usable, blocker }) {
  return async function harnessStates() {
    const basic = (live.acpAdmission?.list() ?? []).map((/** @type {any} */ h) => ({
      id: `acp:${h.id}`,
      label: h.label ?? h.id,
      kind: 'acp',
      state: ADMISSION_STATE[/** @type {keyof typeof ADMISSION_STATE} */ (h.state)] ?? 'checking',
      reason: typeof h.reason === 'string' && h.reason ? h.reason : null,
    }));
    const builtin = await Promise.all(
      ['claude', 'codex'].map(async (id) => ({
        id,
        label: labels[id],
        kind: 'builtin',
        state: (await usable(id)) ? 'ready' : 'unavailable',
        reason: null,
      })),
    );
    return Promise.all(
      [...builtin, ...basic].map(async (h) => {
        const why = await blocker(h.id);
        return { ...h, canSwitch: why === null, switchReason: why };
      }),
    );
  };
}

module.exports = { createHarnessStates };
