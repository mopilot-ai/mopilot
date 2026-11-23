// The real words a Host hands the task core (shared/host), for tests that build a task manager or a failure context.
import { agentLabel } from '../../../shared/host/agentReadiness.mjs';
import { refusalWords } from '../../../shared/host/refusalWords.mjs';
import { turnErrorCode } from '../../../shared/host/turnErrorCode.mjs';
import type { TaskWords } from '../../../shared/momoTasks/types.ts';

export const words: TaskWords = { refusalWords, agentLabel, turnErrorCode };
