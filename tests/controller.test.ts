// ChatController unit-test entrypoint: responsibility-based cases register in their original order in one process.
import { registerQueueCases } from './support/controller/queue';
import { registerApprovalsCases } from './support/controller/approvals';
import { registerOwnershipCases } from './support/controller/ownership';
import { registerLifecycleCases, registerNotificationCases } from './support/controller/lifecycle';
import { registerHarnessesCases } from './support/controller/harnesses';
import { registerSteeringCases } from './support/controller/steering';
import { registerDeliveryCases } from './support/controller/delivery';

registerQueueCases();
registerApprovalsCases();
registerOwnershipCases();
registerLifecycleCases();
registerHarnessesCases();
registerNotificationCases();
registerSteeringCases();
registerDeliveryCases();
