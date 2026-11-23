// Codex harness UT entrypoint: responsibility groups register in original order in one process.
import { registerProcessCases } from './support/codex-harness/process';
import { registerParametersCases } from './support/codex-harness/parameters';
import { registerReconnectCases } from './support/codex-harness/reconnect';
import { registerGoalsCases } from './support/codex-harness/goals';
import { registerLeasesCases } from './support/codex-harness/leases';
import { registerWindowApiCases } from './support/codex-harness/window-api';
import { registerTurnsCases } from './support/codex-harness/turns';
import { registerHelpersCases } from './support/codex-harness/helpers';
import { registerNativeCleanupCases } from './support/codex-harness/native-cleanup';
import { registerFailuresCases } from './support/codex-harness/failures';

registerProcessCases();
registerParametersCases();
registerReconnectCases();
registerGoalsCases();
registerLeasesCases();
registerWindowApiCases();
registerTurnsCases();
registerHelpersCases();
registerNativeCleanupCases();
registerFailuresCases();
