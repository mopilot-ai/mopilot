// AccountDriver for the basic tier: every ACP harness, one instance each. An ACP harness signs in
// and bills on its own (its authMethods; a terminal login or a browser flow), so Sage keeps no
// account pool for it: no failover, no per-chat accounts, nothing to switch to when it runs out.
// One driver covers all of them; the instance's account is the harness id (`gemini`, `goose`, ...).
const { instance } = require('../contract/registry.cjs');

/** An admission state as an instance status: only an admitted harness is usable ('checking', 'unsupported' and 'off' are not). */
const STATUS = { admitted: 'ok', signin: 'signedOut' };

class AcpDriver {
  /** @param {{ list: () => { id: string, label?: string, state: string, authMethods?: any[] }[] }} o the admission list (electron/harness/admission.cjs) */
  constructor(o) {
    this.harness = 'acp';
    this.o = o;
  }
  /** One instance per harness found on this machine; signed out while it asks for a sign-in, unavailable while not admitted. */
  instances() {
    return this.o
      .list()
      .filter((h) => h.state !== 'missing')
      .map((h) =>
        instance({
          harness: 'acp',
          account: h.id,
          provider: { id: `acp:${h.id}`, label: h.label ?? h.id, wires: [], baseUrl: '', firstParty: false },
          kind: 'cliLogin',
          billing: 'harness',
          label: null,
          status: STATUS[h.state] ?? 'unavailable',
          active: true,
        }),
      );
  }
  /** No failover: a harness that runs out says so, and the user decides. */
  get failover() {
    return 'none';
  }
  get perChat() {
    return false;
  }
  get poolPolicy() {
    return { pool: 'single', autoSwitch: false };
  }
  /** What the capability layer reads for a basic harness's chat (Negotiated.accounts). */
  get lane() {
    return { failover: this.failover, perChat: this.perChat, usage: 'none' };
  }
  /** The sign-in methods the harness declared (the Settings row offers them). */
  authMethods(id) {
    return this.o.list().find((h) => h.id === id)?.authMethods ?? [];
  }
}

module.exports = { AcpDriver };
