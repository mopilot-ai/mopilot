// What the home the phone composes itself cannot do: wake, update, set up or sign in a machine are the Mac's own actions (the phone has no way to run them from its own Host sessions), so no surface offers them there. A button that always fails is worse than none: the state is said, the way out is the Mac's. Every builder of actions that has the view passes them through here.
import type { Action } from './common';
import type { PhoneView } from './types';

const MACHINE_ACTIONS = new Set(['wake', 'update-machine', 'set-up-machine', 'install-agent', 'sign-in-agent']);
/** The ids a home's own fix carries for the same actions (`{ kind: 'fix', id }`). */
const MACHINE_FIX = /^(wake|update-machine|set-up-machine|install-agent|sign-in-agent)(:|$)/;

const isMachineAction = (a: Action) => MACHINE_ACTIONS.has(a.intent.kind) || (a.intent.kind === 'fix' && MACHINE_FIX.test(a.intent.id));

/** The actions to offer: all of them on the Mac's home, without the machine actions on the phone's own. */
export const offered = (v: Pick<PhoneView, 'own'>, actions: Action[]): Action[] =>
  v.own ? actions.filter((a) => !isMachineAction(a)) : actions;
