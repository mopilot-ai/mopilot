// Codex adapter cases registered in their original order with shared scripted app-server and session fixtures.
import { registerWorkspace } from './support/codex-adapter/workspace.ts';
import { registerInitialize, registerConnectionRecovery, registerProtocol } from './support/codex-adapter/connection.ts';
import { registerRouting, registerLeases, registerRoutingEdges } from './support/codex-adapter/ownership.ts';
import { registerTurnStarts, registerSteering, registerTurnContext } from './support/codex-adapter/turns.ts';
import { registerTitleStart, registerTitleRecovery, registerTitleGate } from './support/codex-adapter/titles.ts';
import { registerGoalStart, registerGoalRecovery } from './support/codex-adapter/goals.ts';
import { registerCopyFallback } from './support/codex-adapter/fallback.ts';
import { registerGoalPermission } from './support/codex-adapter/permission.ts';

registerWorkspace();
registerInitialize();
registerRouting();
registerTurnStarts();
registerTitleStart();
registerTitleGate();
registerSteering();
registerTitleRecovery();
registerGoalStart();
registerGoalPermission();
registerLeases();
registerTurnContext();
registerConnectionRecovery();
registerCopyFallback();
registerGoalRecovery();
registerProtocol();
registerRoutingEdges();
