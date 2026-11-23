// Browser-panel UI UT entrypoint: scenario groups register in original order in one process.
import { registerBrowserShortcutCases } from './support/browser-panel-ui/shortcuts';
import { registerNavigationNoticesCases } from './support/browser-panel-ui/navigation-notices';
import { registerAttachmentRecoveryCases } from './support/browser-panel-ui/attachment-recovery';
import { registerAgentControlsCases } from './support/browser-panel-ui/agent-controls';
import { registerToolbarCases } from './support/browser-panel-ui/toolbar';
import { registerProfilesChromeCases } from './support/browser-panel-ui/profiles-chrome';
import { registerMainOwnedViewsCases } from './support/browser-panel-ui/main-owned-views';
import { registerRemoteViewCases } from './support/browser-panel-ui/remote-view';
import { registerSuggestionsPasswordsCases } from './support/browser-panel-ui/suggestions-passwords';
import { registerPageEdgesCases } from './support/browser-panel-ui/page-edges';
import { registerTabMenuCases } from './support/browser-panel-ui/tab-menu';

registerNavigationNoticesCases();
registerAttachmentRecoveryCases();
registerAgentControlsCases();
registerToolbarCases();
registerProfilesChromeCases();
registerMainOwnedViewsCases();
registerRemoteViewCases();
registerSuggestionsPasswordsCases();
registerPageEdgesCases();
registerTabMenuCases();

registerBrowserShortcutCases();
