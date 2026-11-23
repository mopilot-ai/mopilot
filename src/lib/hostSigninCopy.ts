// What a sign-in to an agent on one of the user's machines says, in plain words (the words live in shared/host/signinWords.mjs, which the phone reads too). Shared by the chat's sign-in card and Settings › My machines.
import type { HostSigninView } from './native/host';
import { signinStatus as words, type SigninStatus } from '../../shared/host/signinWords.mjs';

export { ACTION_LABEL } from '../../shared/host/signinWords.mjs';
export type { SigninAction, SigninStatus } from '../../shared/host/signinWords.mjs';

/** The sign-in's state in plain words for `label` (the agent's display name); null when there is nothing to say (none started, or cancelled). */
export const signinStatus = (view: HostSigninView | undefined, label: string): SigninStatus | null => words(view, label);
