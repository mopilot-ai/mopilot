// The wire method of MoMo's Google source on a Host (host/src/momoGoogle.mjs): its state, the home's Google clients, a sign-in's two halves and disconnect. It needs the `momo` feature, so a client that cannot see MoMo cannot ask.
import { MOMO_FEATURE } from './momo.mjs';

/** The steps of the source; the reader and the send capability are not among them: they are for code on the Host, never for a client. */
const OPS = ['status', 'iosRedirect', 'configure', 'begin', 'complete', 'disconnect'];
/** A sign-in flow id the home made, and what a client seals to it (a code is a few hundred bytes). */
const FLOW_ID = /^[A-Za-z0-9_-]{16,32}$/;
const MAX_TEXT = 16 * 1024;

/** @param {{ bad: (message: string) => Error, matchOf: (v: unknown, re: RegExp, message: string) => string }} kit */
export default ({ bad, matchOf }) => {
  /** @param {unknown} v @param {string} what */
  const text = (v, what) => {
    if (typeof v !== 'string' || !v || v.length > MAX_TEXT) throw bad(`That is not ${what}.`);
    return v;
  };
  return {
    methods: {
      'host.momoGoogle': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          const op = OPS.find((o) => o === p.op);
          if (!op) throw bad('That is not a step of the Google source.');
          if (op === 'configure')
            return {
              op,
              desktopJson: text(p.desktopJson, 'a Google client file'),
              ...(p.iosClientId === undefined ? {} : { iosClientId: text(p.iosClientId, 'an iOS client id') }),
            };
          if (op === 'begin') {
            if (p.purpose !== 'read' && p.purpose !== 'send') throw bad('That is not a sign-in purpose.');
            if (p.client !== 'desktop' && p.client !== 'ios') throw bad('That is not a Google client.');
            return { op, purpose: p.purpose, client: p.client, redirectUri: text(p.redirectUri, 'a redirect') };
          }
          if (op === 'complete')
            return { op, flowId: matchOf(p.flowId, FLOW_ID, 'That is not a sign-in id.'), sealed: text(p.sealed, 'a sealed redirect') };
          return { op };
        },
      },
    },
  };
};
