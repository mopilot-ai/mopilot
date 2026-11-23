// Computer use in main: policy, grants, native permission requests, tool execution and presentation cases.
import { registerPolicyCases } from './support/computer-use/policy-cases.ts';
import { registerGrantCases, registerGrantWriteCases } from './support/computer-use/grant-cases.ts';
import { registerPermissionCases } from './support/computer-use/permission-cases.ts';
import { registerToolCases } from './support/computer-use/tool-cases.ts';
import { registerPresentationCases } from './support/computer-use/presentation-cases.ts';

registerPolicyCases();
registerGrantCases();
registerPermissionCases();
registerToolCases();
registerPresentationCases();
registerGrantWriteCases();
