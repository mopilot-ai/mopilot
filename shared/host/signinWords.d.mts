export type SigninAction = 'retry' | 'api-key' | 'cancel';
export type SigninStatus = { text: string; action?: SigninAction; code?: string; details?: string };
export type SigninViewLike = {
  state: string;
  codes: string[];
  link: boolean;
  error: string | null;
  reason?: 'no_page' | 'host_update' | null;
};
export const RUNNING_STATES: readonly string[];
export const SIGNIN_WORDS: Readonly<{
  signIn: string;
  newCode: string;
  openPage: string;
  cancel: string;
  send: string;
  codeField: string;
  ended: string;
  openFailed: string;
}>;
export const ACTION_LABEL: Readonly<Record<SigninAction, string>>;
export function signinStatus(view: SigninViewLike | undefined, label: string): SigninStatus | null;
export function wantsCode(view: SigninViewLike | undefined): boolean;
export function startLabel(state: string | undefined): string;
