// The wire method of MoMo's link to the user's other machines (#5474): the owner's own devices make MoMo's key, allow or remove a machine, and after a move register the home's new key. Nothing here starts a task; what a task does is `host.momoTasks`.
import { MOMO_FEATURE } from './momo.mjs';

/** A machine's id is a key of a table: the names an object already has are never one. */
const ID = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_.:-]{1,128}$/;
/** A link is what the dialler is given: a scheme and a body, no spaces or control characters. */
const LINK = /^[a-z][a-z0-9+.-]{1,20}:[^\s\u0000-\u001f\u007f]{1,1900}$/i;
const HOST_ID = /^[0-9a-f]{32}$/;
const KEY = /^[A-Za-z0-9+/=]{20,200}$/;
const OPS = ['key', 'allow', 'disallow', 'contract', 'registered', 'retired'];
const MAX_NAME = 120;
const MAX_LINK = 2000;

/** @param {{ bad: (message: string) => Error, matchOf: (v: unknown, re: RegExp, message: string) => string }} kit */
export default ({ bad, matchOf }) => ({
  features: [MOMO_FEATURE],
  methods: {
    'host.momoLink': {
      access: 'open',
      requires: [MOMO_FEATURE],
      parse: (/** @type {any} */ p) => {
        const op = OPS.find((o) => o === p?.op);
        if (!op) throw bad('That is not something to do with MoMo and another machine.');
        if (op === 'key' || op === 'contract') return { op };
        if (op === 'disallow' || op === 'registered') return { op, id: matchOf(p.id, ID, 'That is not a machine id.') };
        if (op === 'retired') return { op, publicKey: matchOf(p.publicKey, KEY, 'That is not a key.') };
        const m = p.machine;
        if (!m || typeof m !== 'object') throw bad('That is not a machine.');
        if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > MAX_NAME) throw bad('That machine has no name.');
        if (typeof m.link !== 'string' || m.link.length > MAX_LINK || !LINK.test(m.link)) throw bad('That machine has no link.');
        return {
          op,
          machine: {
            id: matchOf(m.id, ID, 'That is not a machine id.'),
            name: m.name.trim(),
            link: m.link,
            hostId: matchOf(m.hostId, HOST_ID, "That is not the machine's Host id."),
          },
        };
      },
    },
  },
});
