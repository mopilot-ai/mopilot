// Native-control main UT entrypoint: case groups register in original order in one process.
import { registerConfigCases } from './support/native-control-main/config';
import { registerCleanupCases } from './support/native-control-main/cleanup';
import { registerStopsCases, registerStopSimulationCases } from './support/native-control-main/stops';
import { registerSubagentsCases, registerOwnershipCases } from './support/native-control-main/subagents';
import { registerToolSessionsCases } from './support/native-control-main/tool-sessions';
import { registerPermissionGatesCases } from './support/native-control-main/permission-gates';

registerConfigCases();
registerCleanupCases();
registerStopsCases();
registerSubagentsCases();
registerStopSimulationCases();
registerToolSessionsCases();
registerPermissionGatesCases();
registerOwnershipCases();
