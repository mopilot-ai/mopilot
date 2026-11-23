// Electron wiring UT entrypoint: responsibility groups register in original order in one process.
import { registerPeerWindowsCases } from './support/electron-wiring/peer-windows';
import { registerPeerServicesCases } from './support/electron-wiring/peer-services';
import { registerSessionHooksCases } from './support/electron-wiring/session-hooks';
import { registerBrowserPolicyCases } from './support/electron-wiring/browser-policy';
import { registerBrowserRoutingCases } from './support/electron-wiring/browser-routing';
import { registerNativeCapabilitiesCases, registerNativeAvailabilityCases } from './support/electron-wiring/native-capabilities';
import { registerDevPreviewsCases } from './support/electron-wiring/dev-previews';
import { registerBrowserViewsCases } from './support/electron-wiring/browser-views';

registerPeerWindowsCases();
registerPeerServicesCases();
registerSessionHooksCases();
registerBrowserPolicyCases();
registerBrowserRoutingCases();
registerNativeCapabilitiesCases();
registerDevPreviewsCases();
registerNativeAvailabilityCases();
registerBrowserViewsCases();
