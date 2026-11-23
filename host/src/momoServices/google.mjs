// Plugs MoMo's Google source into the home (host/src/momoGoogle.mjs): its API for the wire method host.momoGoogle, and the lifecycle (a pause writes the cursors and drops what is only in memory; a wipe revokes the grant at Google first, unless the data is moving).

import { createMomoGoogle } from '../momoGoogle.mjs';

/** @param {{ home: ReturnType<typeof import('../momoHome.mjs').createMomoHome>, report: (message: string) => void }} deps */
export default ({ home, report }) => {
  const google = createMomoGoogle({ home, report });
  home.provide('google', google);
  home.use('google', { start: () => google.start(), pause: () => google.pause(), wipe: () => google.wipe(), seed: () => google.seed() });
};
