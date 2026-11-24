// The Host's handler for `host.momoLink` (shared/host/methods/momoLink.mjs): thin calls into the tasks service's key flow, read with `momo.service('tasks')` inside each call. Like every MoMo method it runs only at the home (the guard) and only for the owner's own devices (the veil), so a client that reaches this socket another way (the local command line, a MoMo home on another machine) is a request no Host knows.
import { isOwner } from '../momoOwner.mjs';
import { onlyAtHome } from '../momoHomeGuard.mjs';

/** @param {{ momo?: ReturnType<typeof import('../momoHome.mjs').createMomoHome> }} deps */
export default ({ momo }) => {
  const home = /** @type {NonNullable<typeof momo>} */ (momo);
  const tasks = () => /** @type {any} */ (home.service('tasks'));
  return {
    guard: onlyAtHome(momo),
    veils: { 'host.momoLink': (/** @type {unknown} */ principal) => !!momo && !!principal && isOwner(principal) && !!momo.granted() },
    handlers: {
      'host.momoLink': async (/** @type {any} */ p) => {
        switch (p.op) {
          case 'key':
            return { publicKey: await tasks().homeKey() };
          case 'allow':
            await tasks().allowMachine(p.machine);
            return { allowed: true };
          case 'disallow':
            await tasks().disallowMachine(p.id);
            return { removed: true };
          case 'contract':
            return tasks().keyContract();
          case 'registered':
            await tasks().keyRegistered(p.id);
            return { registered: true };
          default:
            await tasks().retiredGone(p.publicKey);
            return { forgotten: true };
        }
      },
    },
  };
};
