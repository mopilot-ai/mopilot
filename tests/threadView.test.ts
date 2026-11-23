// Conversation-view UI cases registered in their original order with one shared fixture.
import { registerEntry } from './support/thread-view/entry.ts';
import { registerActivity } from './support/thread-view/activity.ts';
import { registerResults } from './support/thread-view/results.ts';
import { registerMessages } from './support/thread-view/messages.ts';
import { registerNavigation } from './support/thread-view/navigation.ts';
import { registerHarness } from './support/thread-view/harness.ts';
import { registerRecovery } from './support/thread-view/recovery.ts';
import { registerMomo } from './support/thread-view/momo.ts';

registerEntry();
registerActivity();
registerResults();
registerMessages();
registerNavigation();
registerHarness();
registerRecovery();
registerMomo();
