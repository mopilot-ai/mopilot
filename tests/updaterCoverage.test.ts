// Updater unit cases registered in original order with one shared Electron and response fixture.
import { registerChannels, registerWindows } from './support/updater/channels.ts';
import { registerOwnership } from './support/updater/ownership.ts';
import { registerMacos } from './support/updater/macos.ts';
import { registerDownloads } from './support/updater/downloads.ts';
import { registerInstallOwnership, registerInstallation } from './support/updater/installation.ts';
import { registerConfiguration } from './support/updater/configuration.ts';
import { registerOutcomes } from './support/updater/outcome.ts';

registerChannels();
registerOwnership();
registerMacos();
registerDownloads();
registerInstallOwnership();
registerConfiguration();
registerWindows();
registerInstallation();
registerOutcomes();
