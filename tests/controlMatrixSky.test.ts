// Sky matrix cases registered in their original order with shared fake app-server, desktop, and adapter fixtures.
import { registerLocks, registerLockLifecycle, registerLockEdges } from './support/sky-matrix/locks.ts';
import { registerProgramLocks, registerProgramParsing } from './support/sky-matrix/programs.ts';
import { registerCleanup, registerReleaseState, registerRetry, registerLifecycleEdges } from './support/sky-matrix/lifecycle.ts';
import { registerAppApprovals, registerStaleApprovals, registerBlockedApprovals } from './support/sky-matrix/approvals.ts';
import { registerParents } from './support/sky-matrix/parents.ts';
import { registerNarration, registerChromePrompt } from './support/sky-matrix/narration.ts';

export const GUARDS = ['electron/', 'shared/', 'src/harness/', 'src/lib/'];

registerLocks();
registerProgramLocks();
registerLockLifecycle();
registerCleanup();
registerAppApprovals();
registerParents();
registerStaleApprovals();
registerNarration();
registerReleaseState();
registerBlockedApprovals();
registerRetry();
registerChromePrompt();
registerProgramParsing();
registerLockEdges();
registerLifecycleEdges();
