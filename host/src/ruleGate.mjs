// The owner's rules and the spend limit as one check in front of a Host request (plan U2, U5): answers `host.policy`, refuses a mode above the ceiling and a turn over a limit.
import { UnsupportedError } from './errors.mjs';

/**
 * @param {{ policy?: ReturnType<typeof import('./policy.mjs').createPolicy>, spend?: ReturnType<typeof import('./spend.mjs').createSpend> }} rules
 * @param {{ principal?: () => { kind?: string } | null }} who the connection's identity, fixed by the server at authentication
 * @returns {(method: string, params: any) => { value: unknown } | null} refuses a request the rules forbid; answers `host.policy`; null for any other request that may go on
 */
export function ruleGate({ policy, spend }, who) {
  // a connection without a principal is a desktop's (a key paired before clients had kinds)
  const kind = () => who.principal?.()?.kind ?? 'desktop';
  return (method, params) => {
    if (method === 'host.policy') {
      if (!policy) throw new UnsupportedError('This host cannot keep a policy.');
      return { value: policy.replace(params, kind()) };
    }
    // refused here, before the guard, so a refusal is not remembered as the key's answer
    policy?.checkRequest(method, params, kind(), who.principal?.());
    // a turn does not start over a spend limit (a running one is never cut)
    if (spend && (method === 'chat.start' || method === 'chat.send')) {
      spend.notePick(params.chatId, params.model);
      spend.check(params.chatId);
    }
    return null;
  };
}
