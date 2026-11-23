// Automation store cases registered in their original order with shared sandbox and fake Desktop fixtures.
import { registerStorage, registerStorageListings } from './support/automation-store/storage.ts';
import { registerDesktopSync } from './support/automation-store/desktop-sync.ts';
import { registerRemovals } from './support/automation-store/removals.ts';
import { registerMetadata } from './support/automation-store/metadata.ts';
import { registerTransfers } from './support/automation-store/transfers.ts';
import { registerRecovery } from './support/automation-store/recovery.ts';

registerStorage();
registerDesktopSync();
registerStorageListings();
registerRemovals();
registerMetadata();
registerTransfers();
registerRecovery();
