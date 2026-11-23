// Native control UI UT entrypoint: cohesive cases register in original order with one shared mock/DOM fixture.
import { registerNotesCases } from './support/native-control-ui/notes';
import { registerStatusStripsCases } from './support/native-control-ui/status-strips';
import { registerElicitationCases } from './support/native-control-ui/elicitation';
import { registerToolPresentationCases } from './support/native-control-ui/tool-presentation';
import { registerHostApprovalsCases } from './support/native-control-ui/host-approvals';
import { registerBrowserApprovalsCases } from './support/native-control-ui/browser-approvals';

registerNotesCases();
registerStatusStripsCases();
registerElicitationCases();
registerToolPresentationCases();
registerHostApprovalsCases();
registerBrowserApprovalsCases();
