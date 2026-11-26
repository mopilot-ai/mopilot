// What MoMo's home needs of its machines, from the phone's own Host sessions (shared/remote/phoneHosts.mjs): the machines the phone holds an enrollment with, one request on a machine's session, and the grant that tells a Host the signed-in account may see MoMo. The shared home (shared/momoHomeReal.mjs) runs on this the way it runs on the Mac's machines service.
import type { createRealHome } from '../../../../shared/momoHomeReal.mjs';
import { HANDED_OFF_METHODS } from './handOff';

type Hosts = Parameters<typeof createRealHome>[0]['hosts'];
type Machine = ReturnType<Hosts['machines']>[number];

type Session = { request: (method: string, params?: object) => Promise<unknown> };
/** The part of the phone's Host sessions this reads. */
export type PhoneSessions = {
  records(): { machineId: string; name: string; hostKey?: string }[];
  reachable(machineId: string): boolean | null;
  agents(machineId: string): { id: string; label: string; state: 'ready' | 'signin' | 'missing' }[] | null;
  session(machineId: string): Promise<Session>;
};

/**
 * The agents of a machine as the shared home reads them. A machine whose agents the phone has not read yet reads as having one that works: the shared rules
 * would otherwise call the whole home signed out, a cause nobody read. The phone says nothing of which agents are signed in there (compose.ts takes the names out).
 */
const agentsOf = (list: ReturnType<PhoneSessions['agents']>) =>
  list === null
    ? [{ id: 'claude', name: 'Claude', installed: true, signedIn: true }]
    : list.map((a) => ({ id: a.id, name: a.label, installed: a.state !== 'missing', signedIn: a.state === 'ready' }));

/**
 * @param o.sessions the phone's Host sessions
 * @param o.account the signed-in account's id, or null when nobody is signed in (nothing is granted then)
 * @param o.onChange tells when a machine's answer changed (a machine came back, went away)
 */
export function phoneMomoHosts(o: {
  sessions: PhoneSessions;
  account: () => string | null;
  onChange: (fn: () => void) => () => void;
}): Hosts & { grant: (id: string) => Promise<void> } {
  const machines = (): Machine[] =>
    o.sessions.records().map((r) => ({
      id: r.machineId,
      hostId: r.hostKey,
      name: r.name,
      isThisDevice: false,
      // not heard yet counts as reachable: the look is what finds out, and it gives up on its own
      reachable: o.sessions.reachable(r.machineId) !== false,
      current: true,
      // the phone cannot tell whether a machine sleeps or runs for a cloud: no cost is claimed for it
      stays: 'on' as const,
      setUp: true,
      hasHost: true,
      agents: agentsOf(o.sessions.agents(r.machineId)),
    }));
  const call = async (id: string, method: string, params: object = {}) => {
    // nothing that only a Mac does leaves this phone, whoever asks
    if (HANDED_OFF_METHODS.includes(method)) throw new Error(`${method} is not sent from a phone.`);
    return (await o.sessions.session(id)).request(method, params);
  };
  return {
    machines,
    call,
    grant: async (id) => {
      const account = o.account();
      if (account) await call(id, 'host.momoGrant', { account, features: ['momo'] });
    },
    onChange: o.onChange,
  };
}
