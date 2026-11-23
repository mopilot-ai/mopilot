// Browser tool UT entrypoint: cohesive case modules register in original order in one process.
import { registerContractsCases } from './support/browser-host-tools/contracts';
import { registerNavigationCases } from './support/browser-host-tools/navigation';
import { registerComputerCases } from './support/browser-host-tools/computer';
import { registerPageOperationsCases } from './support/browser-host-tools/page-operations';
import { registerUploadsBatchesCases } from './support/browser-host-tools/uploads-batches';
import { registerSecurityCases } from './support/browser-host-tools/security';
import { registerPageDiffsCases } from './support/browser-host-tools/page-diffs';

registerContractsCases();
registerNavigationCases();
registerComputerCases();
registerPageOperationsCases();
registerUploadsBatchesCases();
registerSecurityCases();
registerPageDiffsCases();
