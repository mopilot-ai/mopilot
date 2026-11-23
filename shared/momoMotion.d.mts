export type MomoDurName = 'xs' | 's' | 'm' | 'l' | 'xl';
export type MomoEaseName = 'out' | 'snap' | 'overshoot';
export const MOMO_DUR: Readonly<Record<MomoDurName, number>>;
export const MOMO_THREAD: Readonly<Record<'rise' | 'dots' | 'arrive', number>>;
export const MOMO_EASE: Readonly<Record<MomoEaseName, readonly [number, number, number, number]>>;
export function cssCurve(name: MomoEaseName): string;
export function momoMotionVars(): Record<string, string>;
