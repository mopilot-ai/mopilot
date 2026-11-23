// In-app browser backend UT entrypoint: case groups register in original order in one process.
import { registerPolicyPeerCheckCases } from './support/iab-backend/policy-peer-check';
import { registerRpcCases } from './support/iab-backend/rpc';
import { registerSessionsTabsCases, registerHandlerContractsCases } from './support/iab-backend/sessions-tabs';
import { registerCdpCases } from './support/iab-backend/cdp';
import { registerPermissionsCases } from './support/iab-backend/permissions';
import { registerCaptureCases, registerViewportRecoveryCases } from './support/iab-backend/capture';
import { registerActionQueueCases } from './support/iab-backend/action-queue';
import { registerSocketsCases } from './support/iab-backend/sockets';

registerPolicyPeerCheckCases();
registerRpcCases();
registerSessionsTabsCases();
registerCdpCases();
registerPermissionsCases();
registerCaptureCases();
registerActionQueueCases();
registerSocketsCases();
registerHandlerContractsCases();
registerViewportRecoveryCases();
