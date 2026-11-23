// When a goal that was running has finished or stopped short, it is worth a system notification;
// a pause the user asked for, or a goal being set or cleared, is not.

import { ownTable } from './ownTable.mjs';

const GOAL_BODY = ownTable({
  complete: 'Goal complete',
  blocked: 'Goal blocked',
  budgetLimited: 'Goal paused · Budget reached',
  usageLimited: 'Goal paused · Usage limit reached',
  stopped: 'Goal stopped before it was met',
});

/** @returns {{ status: string, body: string } | null} */
export function goalNotice(prev, next) {
  if (prev?.status !== 'active' || !next) return null;
  const body = GOAL_BODY[next.status];
  return body ? { status: next.status, body } : null;
}
