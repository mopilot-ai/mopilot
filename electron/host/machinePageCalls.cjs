// What a machine's page (Settings › Machines, X2) reads from the machine's Host and does there, answered in the shapes the page draws: the client table (a Host calls a client by its fingerprint; the page by `id`, and marks this Mac's own), a client's removal, the last lines of the audit record, and the Host's status (spend and the managed layer). One paired exchange per call, closed after (the app's long-lived connection to a Host is refused until it is up, which a page opened the moment a machine is first used would meet); a Host that lacks the feature refuses as `feature_missing`, which leaves that section out of the page.
const { helloParams } = require('../../shared/host/schema.mjs');
const { clientListOf } = require('../../shared/host/clients.mjs');

/** How many audit lines the page shows, and how many a read asks for at once. */
const SHOWN = 50;
const PAGE = 100;
/** A record longer than this many reads is shown by its last lines only. */
const MAX_READS = 20;

/** @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {object} o
 * @param {(machineId: string) => Promise<{ call: (method: string, params?: object) => Promise<any>, close: () => void }>} o.pairedFor a paired connection to the machine
 * @param {() => string} o.selfFingerprint this Mac's client fingerprint on a Host
 */
function createMachinePageCalls({ pairedFor, selfFingerprint }) {
  /** One paired exchange that needs `feature` (none: any Host). @template T @param {string} id @param {string | null} feature @param {(s: { call: (method: string, params?: object) => Promise<any> }) => Promise<T>} run */
  async function exchange(id, feature, run) {
    const s = await pairedFor(id);
    try {
      const hello = await s.call('host.hello', helloParams());
      if (feature && !(Array.isArray(hello?.features) ? hello.features : []).includes(feature))
        throw refusal('This machine’s Host is older than this app.', 'feature_missing');
      return await run(s);
    } finally {
      s.close();
    }
  }
  return {
    /** The machine's clients as the page reads them. @param {string} id */
    clients: (id) =>
      exchange(id, 'clients', async (s) => ({
        clients: clientListOf(await s.call('host.clients', {})).map((c) => ({
          id: c.fingerprint,
          name: c.name,
          kind: c.kind,
          addedAt: c.addedAt || null,
          self: c.fingerprint === selfFingerprint(),
        })),
      })),
    /** Takes a client off the machine: its Host closes its connections at once. @param {string} id @param {string} fingerprint */
    removeClient: (id, fingerprint) => exchange(id, 'clients', (s) => s.call('host.clientRemove', { fingerprint: String(fingerprint) })),
    /** The last audit lines, newest first. @param {string} id */
    audit: (id) =>
      exchange(id, 'audit', async (s) => {
        /** @type {any[]} */
        let lines = [];
        let after = 0;
        for (let reads = 0; reads < MAX_READS; reads++) {
          const page = await s.call('host.auditRead', { after, limit: PAGE });
          lines = [...lines, ...(Array.isArray(page?.lines) ? page.lines : [])].slice(-SHOWN);
          if (!Array.isArray(page?.lines) || page.lines.length < PAGE) break;
          after = page.next;
        }
        return {
          lines: lines
            .reverse()
            .map((l) => ({ at: l.at, kind: l.kind, who: l.by?.name ?? '', ...(l.by?.kind ? { whoKind: l.by.kind } : {}) })),
        };
      }),
    /** The Host's own status now: today's spend and the managed layer. @param {string} id */
    hostStatus: (id) => exchange(id, null, (s) => s.call('host.status', {})),
  };
}

module.exports = { createMachinePageCalls };
