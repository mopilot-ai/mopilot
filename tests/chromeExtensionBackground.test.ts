// Extension background unit cases registered in their original order with shared fake browser and connection fixtures.
import { registerProtocol } from './support/extension-background/protocol.ts';
import { registerSessions } from './support/extension-background/sessions.ts';
import { registerClient } from './support/extension-background/client.ts';
import { registerWorker } from './support/extension-background/worker.ts';
import { registerOptions } from './support/extension-background/options.ts';
import { registerBuild } from './support/extension-background/build.ts';
import { registerNativeHost } from './support/extension-background/native-host.ts';

registerProtocol();
registerSessions();
registerClient();
registerWorker();
registerOptions();
registerBuild();
registerNativeHost();
