// The options page's entry (options.html): the connection (src/options.mjs) and the settings tabs (src/optionsTabs.mjs).
import { startOptions } from './src/options.mjs';
import { OptionsTabs } from './src/optionsTabs.mjs';

const tabs = new OptionsTabs(globalThis);
// the name and sites are MoPilot's: read again once it connects
startOptions(globalThis, { onConnected: () => void tabs.load() });
void tabs.select('connection');
