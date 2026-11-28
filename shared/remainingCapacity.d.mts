/** What a harness has left (remainingCapacity). */
export interface Capacity {
  /** every plan login it could run on is out until a reset */
  limited: boolean;
  /** the billing of the pay-per-use instance it runs on now ('apiKey', 'credits'), or null on its plan logins */
  payPerUse: string | null;
  /** fraction left of its plan logins together, 0..1; null when not known (or pay per use) */
  fraction: number | null;
  /** what its plan logins hold together, in plan units; null when not known (or pay per use) */
  units: number | null;
}
export const LOW_CAPACITY: number;
export const PLAN_SIZES: Readonly<{ codex: Readonly<Record<string, number>>; claude: Readonly<Record<string, number>> }>;
export function planUnitsOf(sizes: Readonly<Record<string, number>>, plan: string | null | undefined): number | null;
export function planUnits(harness: string, plan: string | null | undefined): number | null;
export function accountRemaining(a: { left: number | null | undefined; units: number | null | undefined }): number | null;
export function remainingCapacity(
  instances:
    | readonly ({
        account: string;
        status: string;
        limited: boolean;
        active?: boolean;
        billing?: string;
        left?: number | null;
        units?: number | null;
      } | null)[]
    | null
    | undefined,
  kind: string,
): Capacity | null;
