// Runs harness contract, account presentation and ACP translation edge cases in their original order.
import { registerContracts, registerContractFallback } from './support/harness-pure-edges/contracts.ts';
import { registerAccounts } from './support/harness-pure-edges/accounts.ts';
import { registerAcp } from './support/harness-pure-edges/acp.ts';

registerContracts();
const accounts = await import('../src/harness/accounts.ts');
const acpT = {
  ...(await import('../electron/harness/items/acpTranslator.cjs')),
  ...(await import('../shared/acpItems/permissionChoices.mjs')),
  ...(await import('../shared/acpItems/toolItems.mjs')),
  ...(await import('../shared/acpStop.mjs')),
};
registerAccounts(accounts);
registerAcp(acpT);
registerContractFallback();
