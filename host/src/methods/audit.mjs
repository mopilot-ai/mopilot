// The Host's handler for `host.auditRead` (feature `audit`): the lines after a sequence number, for the app's own "Activity on this machine" view. A phone cannot read it: the record names every device and what each did.
import { HostRefusal } from '../hostFs.mjs';
import { UnsupportedError } from '../errors.mjs';

/** @param {{ audit?: ReturnType<typeof import('../audit.mjs').createAudit> }} deps */
export default ({ audit }) => ({
  handlers: {
    'host.auditRead': (/** @type {{ after: number, limit: number }} */ p, /** @type {string} */ kind) => {
      if (!audit) throw new UnsupportedError('This host keeps no audit record.');
      if (kind !== 'desktop' && kind !== 'cli') throw new HostRefusal('forbidden', 'This client may not read the record.');
      return audit.read(p);
    },
  },
});
