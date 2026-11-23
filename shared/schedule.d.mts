export function scheduleTime(value: unknown): number;
export function scheduleTime<T>(value: unknown, fallback: T): number | T;
export function anchorDays(periodMs: number, interval: number): number;
export const ATTENTION_MS: number;
export const CATCH_UP_MS: number;
export interface ScheduleRules {
  describe(rule: string): string;
  nextRun(rule: string, after?: Date, zone?: string): Date | null;
  lastRun(rule: string, at: number, zone?: string): number | null;
}
export function isTimeZone(zone: unknown): zone is string;
export function scheduleRules(RRule: unknown): ScheduleRules;
export function toCron(rule: string): string | null;
export function fromCron(expr: string): string | null;
