// Browser-script UT entrypoint: responsibility groups register in original order in one process.
import { registerPageOperationsCases } from './support/browser-script/page-operations';
import { registerRawInputCases } from './support/browser-script/raw-input';
import { registerLocatorsCases } from './support/browser-script/locators';
import { registerWorkerSessionsCases } from './support/browser-script/worker-sessions';
import { registerToolResultsCases } from './support/browser-script/tool-results';
import { registerPermissionsStopCases } from './support/browser-script/permissions-stop';

registerPageOperationsCases();
registerRawInputCases();
registerLocatorsCases();
registerWorkerSessionsCases();
registerToolResultsCases();
registerPermissionsStopCases();
