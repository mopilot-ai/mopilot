// Chrome comparison unit cases registered in their original order with fake drivers and transport; no real browsers launch.
import { registerTaskResults } from './support/chrome-comparison/task-results.ts';
import { registerGuards, registerProcessGuards, registerExtensionGate } from './support/chrome-comparison/guards.ts';
import { registerOrchestration } from './support/chrome-comparison/orchestration.ts';
import { registerDriver, registerExtensionDriver } from './support/chrome-comparison/driver.ts';
import { registerExtension } from './support/chrome-comparison/extension.ts';
import { registerActions } from './support/chrome-comparison/actions.ts';

registerTaskResults();
registerGuards();
registerOrchestration();
registerProcessGuards();
registerDriver();
registerExtension();
registerExtensionDriver();
registerExtensionGate();
registerActions();
