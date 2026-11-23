// Isolated native link/Needs-input repro: production screens and stack, with only the computer transport replaced.
import { registerRootComponent } from 'expo';
import { MobileApp } from './src/MobileApp';

const parent = 'claude:11111111-1111-4111-8111-111111111111';
const side = 'acp:gemini-cli:22222222-2222-4222-8222-222222222222';
const waiting = '019a0000-0000-7000-8000-000000000001';
const chats = [
  { id: parent, title: 'Link origin', state: 'running', harness: 'claude' },
  { id: side, title: 'Linked target', state: 'running', harness: 'acp:gemini-cli' },
  { id: 'family', title: 'Family parent', state: 'running', harness: 'claude' },
  { id: waiting, title: 'Waiting child', state: 'waiting', harness: 'codex', parentId: 'family' },
];
const snapshot = {
  phase: 'online',
  generation: 1,
  user: { id: 'isolated-phone-links' },
  pairs: [{ pairId: 'pair', macId: 'mac', name: 'Fake computer' }],
  selectedPair: 'pair',
  safetyNumber: null,
  pendingPair: false,
  pairCleanup: false,
  presence: {},
  reconnect: null,
  error: null,
  outbox: [],
};
const plan = {
  id: 'plan',
  rev: 1,
  kind: 'plan',
  title: 'Child approval',
  plan: { text: `[Plan destination](mopilot:chat/${side})` },
  choices: [{ key: 'approve', label: 'Approve plan' }],
};
const runtime: any = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  start: async () => {},
  connect: async () => {},
  onEvent: () => () => {},
  request: async (method: string, params: any) => {
    if (method === 'chats.recent') return { chats };
    if (method === 'chat.follow')
      return {
        rev: 1,
        feedSeq: 0,
        itemsShape: 'rows',
        session: { turn: params.chatId === waiting ? 'awaitingUser' : 'idle', cards: params.chatId === waiting ? [plan] : [] },
        items: [
          {
            role: 'assistant',
            text:
              params.chatId === parent
                ? `[Open linked target](mopilot:chat/${side})`
                : params.chatId === side
                  ? `Native target reply.\n\n[Return to origin](mopilot:chat/${parent})`
                  : 'Waiting child transcript.',
          },
        ],
      };
    return {};
  },
};
registerRootComponent(() => <MobileApp runtime={runtime} />);
