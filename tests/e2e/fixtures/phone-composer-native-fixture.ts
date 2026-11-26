// Deterministic Mac/media boundaries for the native composer journey, exercised by production client decoders.

const chat = 'claude:11111111-1111-4111-8111-111111111111';
const started = '019a0000-0000-7000-8000-000000000001';
const snapshot = {
  phase: 'online',
  generation: 1,
  user: { id: 'isolated-composer', name: 'Native' },
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
const methods = [
  'commands.list',
  'mentions.list',
  'mentions.start',
  'chat.start',
  'chat.attach',
  'options.get',
  'harnesses.list',
  'projects.list',
  'chat.follow',
  'chat.unfollow',
];
const commands = Array.from({ length: 8 }, (_, i) => ({
  name: `native0${i}`,
  description: `Native menu row ${i}`,
  hint: '',
  kind: 'command',
  as: 'text',
}));
const mentions = {
  chats: [{ id: chat, title: 'Native companion' }],
  files: Array.from({ length: 12 }, (_, i) => ({ path: `src/file${i}.ts`, name: `file${i}.ts`, directory: false })),
};
let accepted: any = null;
export const runtime: any = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  onEvent: () => () => {},
  features: async () => ['phone'],
  start: async () => {},
  connect: async () => {},
  send: () => {},
  request: async (method: string, p: any) => {
    if (method === 'chats.recent') return { chats: [{ id: chat, title: 'Composer native chat', state: 'running', harness: 'claude' }] };
    if (method === 'machine.hello') return { capabilities: { methods, permissionCeiling: 'auto-review' } };
    if (method === 'harnesses.list')
      return {
        harnesses: [
          { id: 'claude', label: 'Claude Code' },
          { id: 'codex', label: 'Codex' },
        ],
      };
    if (method === 'projects.list') return { projects: [{ id: 'native', name: 'Native project' }] };
    if (method === 'options.get')
      return {
        models: [{ id: 'native-model', label: 'Native model', efforts: [], defaultEffort: null }],
        model: 'native-model',
        effort: null,
        permission: { value: 'default', rows: [{ id: 'default', label: 'Ask', detail: 'Ask first' }] },
      };
    if (method === 'commands.list')
      return {
        commands:
          p.harness === 'codex'
            ? [{ name: 'native-skill', description: 'Native selected skill', hint: '', kind: 'skill', as: 'skill' }]
            : commands,
      };
    if (method === 'mentions.start') return p.projectId === 'native' ? mentions : { chats: [], files: [] };
    if (method === 'mentions.list') {
      if (p.chatId !== chat && p.chatId !== started) throw new Error('Follow an existing chat before reading its files.');
      return mentions;
    }
    if (method === 'chat.start') {
      accepted = p;
      return { chatId: started };
    }
    if (method === 'chat.attach')
      return {
        stream: p.stream,
        received: p.index + 1,
        done: p.index + 1 === p.total,
        ...(p.index + 1 === p.total ? { id: '0123456789abcdef', name: p.name, kind: 'image' } : {}),
      };
    if (method === 'chat.follow')
      return {
        rev: 1,
        feedSeq: 0,
        itemsShape: 'rows',
        session: { turn: 'idle', cards: [] },
        items:
          p.chatId === started
            ? [{ role: 'assistant', text: `Native start accepted: ${accepted?.skills?.join(',')}; ${accepted?.text}` }]
            : [
                { role: 'assistant', text: 'Tap native transcript to dismiss' },
                ...Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', text: `Native transcript line ${i}` })),
              ],
      };
    return {};
  },
};
const image = {
  name: 'native-pattern.png',
  mime: 'image/png',
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAYAAADS1n9/AAAAzklEQVR4nO3SQQ0AIBAEMSQgCalIOkeHCZIloY9RMB29dv/crPq6kR6QLj0gHQAPTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0gPSAfDABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgDsd8trVKS7yINcAAAAASUVORK5CYII=',
};
export const media: any = {
  recent: async () => ({ access: 'full', photos: [] }),
  manageLimited: async () => {},
  library: async () => ({ picked: [image], refused: [] }),
  camera: async () => image,
  photos: async () => [image],
  files: async () => [],
  startRecording: async () => {},
  stopRecording: async () => ({ base64: '', mime: 'audio/wav' }),
  cancelRecording: async () => {},
  level: () => null,
};
