export const PUSH_TITLE_EVENT: 'push.titleKey';
export const PUSH_TITLE_AAD_PREFIX: 'mopilot-push-title-v1|';
export const PUSH_TITLE_MAX_UNITS: 120;
export const PUSH_BODY_AAD_PREFIX: 'mopilot-push-body-v1|';
export const PUSH_BODY_PAD_BYTES: 160;
export const PUSH_SETTINGS: Readonly<{
  titlesInPush: Readonly<{ key: 'titlesInPush'; default: false }>;
  mode: Readonly<{ key: 'notifyOnComplete'; values: readonly string[]; default: 'unfocused' }>;
  kinds: Readonly<{ key: 'notifyKinds'; values: readonly string[]; default: true }>;
  quietHours: Readonly<{ key: 'notifyQuietHours'; default: null }>;
  momoQuietHours: Readonly<{ key: 'momo.routines.quietHours'; default: Readonly<{ start: string; end: string }> }>;
}>;
export function readQuietHours(v: unknown): { start: string; end: string } | null;
export const PUSH_OPT_IN_KINDS: readonly string[];
export function pushesToPhone(kinds: unknown, kind: string): boolean;
