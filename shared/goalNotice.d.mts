import type { ChatGoal, ChatGoalStatus } from './model/store';

export function goalNotice(prev: ChatGoal | null | undefined, next: ChatGoal | null): { status: ChatGoalStatus; body: string } | null;
