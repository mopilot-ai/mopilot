// Runs Your Chrome transport, lifecycle, permission and selection cases in their original order.
import {
  registerEntryContracts,
  registerSpawnAndResults,
  registerPinnedCliSchemas,
  registerProcessFailures,
} from './support/your-chrome/transport.ts';
import { registerChannelLifecycle, registerChannelRecovery, registerConnectionFallbacks } from './support/your-chrome/channel.ts';
import {
  registerToolRefusals,
  registerToolPermissions,
  registerSelectorCompatibility,
  registerApprovalOwnership,
  registerToolDefaults,
} from './support/your-chrome/tools.ts';
import {
  registerSelectionAndTokens,
  registerCoreSchemaSwitching,
  registerSelectionRecovery,
  registerLiveFlags,
} from './support/your-chrome/selection.ts';

registerEntryContracts();
registerToolRefusals();
registerSpawnAndResults();
registerChannelLifecycle();
registerToolPermissions();
registerSelectionAndTokens();
registerPinnedCliSchemas();
registerCoreSchemaSwitching();
registerSelectorCompatibility();
registerSelectionRecovery();
registerApprovalOwnership();
registerLiveFlags();
registerProcessFailures();
registerChannelRecovery();
registerToolDefaults();
registerConnectionFallbacks();
