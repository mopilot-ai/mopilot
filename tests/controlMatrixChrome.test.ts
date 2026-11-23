// Browser control matrix cases registered in their original order with a shared fake SDK and Chrome fixtures.
import { registerClaudeLink } from './support/chrome-matrix/claude-link.ts';
import { registerChannelHandoff } from './support/chrome-matrix/channel-handoff.ts';
import { registerPasskeys, registerSubframePasskeys } from './support/chrome-matrix/passkeys.ts';
import { registerNarration } from './support/chrome-matrix/narration.ts';
import { registerHandoffRecord } from './support/chrome-matrix/handoff-record.ts';
import { registerCredentialWiring, registerRouteWiring } from './support/chrome-matrix/main-wiring.ts';
import { registerRouting } from './support/chrome-matrix/routing.ts';
import { registerSignIn } from './support/chrome-matrix/sign-in.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

registerClaudeLink();
registerChannelHandoff();
registerPasskeys();
registerNarration();
registerHandoffRecord();
registerCredentialWiring();
registerRouting();
registerSignIn();
registerRouteWiring();
registerSubframePasskeys();
