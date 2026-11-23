// Site-permission matrix cases registered in their original order with shared browser fixtures.
import { registerSiteTables } from './support/site-contracts/site-tables.ts';
import { registerChromeWrites } from './support/site-contracts/chrome-writes.ts';
import { registerBackendPolicy } from './support/site-contracts/backend-policy.ts';
import { registerPluginRules } from './support/site-contracts/plugin-rules.ts';
import {
  registerPluginTabs,
  registerViewport,
  registerCrashedTab,
  registerCrashedMidCommand,
} from './support/site-contracts/plugin-tabs.ts';
import { registerHandoff, registerRouting, registerNarration } from './support/site-contracts/handoff.ts';
import { registerContracts } from './support/site-contracts/contracts.ts';

export const GUARDS = ['electron/', 'shared/', 'src/lib/'];

registerSiteTables();
registerChromeWrites();
registerBackendPolicy();
registerPluginRules();
registerPluginTabs();
registerHandoff();
registerViewport();
registerCrashedTab();
registerCrashedMidCommand();
registerRouting();
registerContracts();
registerNarration();
