// Native availability cases registered in their original order with shared in-memory runtime fixtures.
import { registerProbe, registerVendorProfiles } from './support/native-availability/probe.ts';
import { registerSkyStatus } from './support/native-availability/sky-status.ts';
import { registerSurfaceDecisions } from './support/native-availability/surface-decisions.ts';
import { registerLifecycle } from './support/native-availability/lifecycle.ts';
import { registerThreadConfig } from './support/native-availability/thread-config.ts';

registerProbe();
registerSkyStatus();
registerSurfaceDecisions();
registerLifecycle();
registerThreadConfig();
registerVendorProfiles();
