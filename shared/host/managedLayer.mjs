// The managed layer a Host merges under the owner's rules (plan W2): the managed document's Host-side keys in the shape `mergePolicy` reads, plus the checks that read the document directly (harnesses, phones, credentials, roots).

/**
 * The layer `mergePolicy` takes: the ceiling, the approval pause cap and the spend limits, each only when the document sets it.
 * @param {any} doc a parsed managed document
 */
export function hostLayerOf(doc) {
  /** @type {Record<string, any>} */
  const layer = {};
  if (doc.permission?.max !== undefined) layer.permissionMax = doc.permission.max;
  if (doc.hosts?.approvals?.pauseMinutesMax !== undefined) layer.approvals = { pauseMinutes: doc.hosts.approvals.pauseMinutesMax };
  if (doc.spend) {
    layer.spend = {
      ...(doc.spend.dayUsdMax === undefined ? {} : { dayUsd: doc.spend.dayUsdMax }),
      ...(doc.spend.chatUsdMax === undefined ? {} : { chatUsd: doc.spend.chatUsdMax }),
    };
  }
  if (doc.cloud) {
    layer.cloud = {
      ...(doc.cloud.idleMinutesMax === undefined ? {} : { idleMinutes: doc.cloud.idleMinutesMax }),
      ...(doc.cloud.hoursPerDayMax === undefined ? {} : { hoursPerDay: doc.cloud.hoursPerDayMax }),
    };
  }
  return layer;
}

/** The harness id a policy list names: an ACP agent is `acp:<id>` on the wire and `<id>` in the document. @param {string} harness */
export const harnessKey = (harness) => harness.slice(harness.lastIndexOf(':') + 1);

/** Whether a managed document lets `harness` start chats. @param {any} doc @param {string} harness */
export const harnessAllowed = (doc, harness) => !doc?.harnesses?.allow || doc.harnesses.allow.includes(harnessKey(harness));
