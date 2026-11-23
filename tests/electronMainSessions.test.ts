// Main session wiring cases registered in their original order with one fake timer and main-harness fixture.
import { registerStartup } from './support/main-sessions/startup.ts';
import { registerEvents, registerEarlyPublishing, registerPeerPreviews } from './support/main-sessions/events.ts';
import { registerCodexAdapter, registerHarnessAdapters } from './support/main-sessions/adapters.ts';
import { registerController } from './support/main-sessions/controller.ts';
import { registerIpc } from './support/main-sessions/ipc.ts';
import { registerScheduler } from './support/main-sessions/scheduler.ts';

registerStartup();
registerEvents();
registerCodexAdapter();
registerEarlyPublishing();
registerHarnessAdapters();
registerController();
registerIpc();
registerScheduler();
registerPeerPreviews();
