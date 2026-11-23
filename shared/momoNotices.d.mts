// Types for shared/momoNotices.mjs: MoMo's fixed notification titles and the one opt-in push body.
export type MomoNoticeKind = 'needsYou';
export const MOMO_NOTICE_TITLES: Readonly<Record<MomoNoticeKind, string>>;
export function momoMergedTitle(n: number): string;
export const MOMO_PUSH_BODY_MAX_UNITS: number;
export function momoPushBody(o: { optIn: boolean; routine: { name?: unknown; approved?: unknown } | null | undefined }): string;
