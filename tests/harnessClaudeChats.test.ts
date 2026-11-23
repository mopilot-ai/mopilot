// Claude renderer chat unit cases registered in original order with one shared event fixture.
import { registerStartup, registerFailedStartup } from './support/claude-chat/startup.ts';
import { registerChats } from './support/claude-chat/chats.ts';
import { registerTurns } from './support/claude-chat/turns.ts';
import { registerEvents } from './support/claude-chat/events.ts';
import { registerFollowing } from './support/claude-chat/following.ts';
import { registerCommands, registerSessionSettings, registerTaskStops } from './support/claude-chat/commands.ts';
import { registerEdits } from './support/claude-chat/edits.ts';

registerStartup();
registerChats();
registerTurns();
registerEvents();
registerFollowing();
registerCommands();
registerEdits();
registerSessionSettings();
registerFailedStartup();
registerTaskStops();
