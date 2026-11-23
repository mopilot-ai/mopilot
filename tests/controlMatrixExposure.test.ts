// Exposure matrix cases registered in their original order with shared fake harness, controller, and socket fixtures.
import { registerControllers, registerLiveSwitches } from './support/exposure-matrix/controllers.ts';
import { registerChannels } from './support/exposure-matrix/channels.ts';
import { registerAvailability } from './support/exposure-matrix/availability.ts';
import { registerBilling, registerHelpers } from './support/exposure-matrix/claude-sessions.ts';
import { registerStaleLists } from './support/exposure-matrix/stale-lists.ts';
import { registerDegradedNotes, registerManagedParity } from './support/exposure-matrix/codex-context.ts';

export const GUARDS = ['electron/', 'shared/'];

registerControllers();
registerLiveSwitches();
registerChannels();
registerAvailability();
registerBilling();
registerHelpers();
registerStaleLists();
registerDegradedNotes();
registerManagedParity();
