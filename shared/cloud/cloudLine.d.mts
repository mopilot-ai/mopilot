export type CloudState = {
  gone?: boolean;
  creating?: 'create' | 'start' | 'connect' | 'pair' | null;
  waking?: boolean;
  asleep?: boolean;
  stopping?: boolean;
  canWake?: boolean;
};
export const CREATE_WORDS: Readonly<Record<'create' | 'start' | 'connect' | 'pair', string>>;
export function cloudLine(s: CloudState): { line: string; dot: 'off' | 'warn'; action: 'Remove' | 'Cancel' | 'Wake' | null } | null;
export function idleWords(minutes: number | undefined): string | undefined;
export const WAKES_WHEN_YOU_START: string;
export function hoursRunWords(name: string, hours: number): string;
