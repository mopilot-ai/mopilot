// Local document owns the pairing QR and safety-number decision; retiring it declines pending work. Another window asking takes over a QR nobody has scanned, never a phone being confirmed.
function createSettingsPairing(getPairing) {
  /** @typedef {{ owner: string, pairing: any, state: string, qr: string | null, expiresAt: number | null, device: string | null, number: string | null, resolve: ((answer: 'allow' | 'deny' | null) => void) | null }} PairingEntry */
  /** @type {PairingEntry | null} */
  let current = null;
  let generation = 0;
  /** @param {string | null} [owner] */
  const cancel = (owner = null) => {
    if (
      !current ||
      ['finishing', 'uncertain', 'storage-locked', 'cancelled-start'].includes(current.state) ||
      (owner && current.owner !== owner)
    )
      return false;
    const old = current;
    current = old.state === 'starting' ? old : null;
    if (current) current.state = 'cancelled-start';
    generation++;
    old.resolve?.(null);
    old.pairing.cancel();
    return true;
  };
  return {
    async begin(owner) {
      if (current && ['paired', 'declined', 'expired', 'rejected', 'failed', 'cancelled'].includes(current.state)) cancel(current.owner);
      if (current?.state === 'waiting' && current.owner !== owner) cancel(current.owner);
      if (current) throw new Error('A pairing is already in progress');
      const pairing = getPairing();
      if (!pairing) throw new Error('Mobile Remote is unavailable');
      const mine = ++generation;
      /** @type {PairingEntry} */
      const entry = { owner, pairing, state: 'starting', qr: null, expiresAt: null, device: null, number: null, resolve: null };
      current = entry;
      try {
        const result = await pairing.begin();
        if (current !== entry || generation !== mine) {
          pairing.cancel();
          if (current === entry) current = null;
          throw new Error('The pairing was cancelled');
        }
        entry.state = 'waiting';
        entry.qr = result.qr;
        entry.expiresAt = result.expiresAt;
        return this.snapshot(owner);
      } catch (error) {
        if (current === entry) {
          current = null;
          pairing.cancel();
        }
        throw error;
      }
    },
    confirm({ device, safetyNumber, signal }) {
      const entry = current;
      if (!entry || signal.aborted) return Promise.resolve(null);
      entry.state = 'confirming';
      entry.qr = null;
      entry.device = device.name;
      entry.number = safetyNumber;
      return new Promise((resolve) => {
        const done = (answer) => {
          signal.removeEventListener('abort', aborted);
          if (entry.resolve === done) entry.resolve = null;
          resolve(answer);
        };
        const aborted = () => {
          if (current === entry) cancel(entry.owner);
          else done(null);
        };
        entry.resolve = done;
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      });
    },
    answer(owner, allow) {
      const entry = current;
      if (!entry || entry.owner !== owner || entry.state !== 'confirming' || !entry.resolve || typeof allow !== 'boolean') return false;
      const resolve = entry.resolve;
      entry.state = allow ? 'finishing' : 'declined';
      resolve(allow ? 'allow' : 'deny');
      return true;
    },
    event(pairing, event) {
      if (!current || current.pairing !== pairing) return;
      if (['paired', 'declined', 'expired', 'rejected', 'failed', 'cancelled'].includes(event.state)) {
        current.state = event.state === 'failed' && ['uncertain', 'storage-locked'].includes(event.error) ? event.error : event.state;
        current.qr = null;
        current.number = null;
      }
    },
    snapshot(owner) {
      const entry = current;
      if (!entry) return null;
      if (entry.owner !== owner)
        return ['uncertain', 'storage-locked'].includes(entry.state)
          ? { state: entry.state, qr: null, expiresAt: null, device: null, safetyNumber: null }
          : ['starting', 'waiting', 'confirming', 'finishing'].includes(entry.state)
            ? { state: 'elsewhere', qr: null, expiresAt: null, device: null, safetyNumber: null }
            : null;
      return { state: entry.state, qr: entry.qr, expiresAt: entry.expiresAt, device: entry.device, safetyNumber: entry.number };
    },
    cancel,
    retire() {
      if (current && ['finishing', 'uncertain', 'storage-locked'].includes(current.state)) {
        current = null;
        generation++;
      } else cancel();
    },
  };
}
module.exports = { createSettingsPairing };
