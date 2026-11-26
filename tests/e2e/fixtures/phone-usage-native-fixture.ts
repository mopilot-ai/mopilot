// Deterministic Mac boundary for the native Settings usage journey, exercised by the production client decoders.

const snapshot = {
  phase: 'online',
  generation: 1,
  user: { id: 'isolated-usage', name: 'Native' },
  pairs: [{ pairId: 'pair', macId: 'mac', name: 'Fake computer' }],
  selectedPair: 'pair',
  safetyNumber: null,
  pendingPair: false,
  pairCleanup: false,
  presence: { mac: { online: true } },
  reconnect: null,
  error: null,
  outbox: [],
};
const methods = ['usage.get', 'chat.follow', 'chat.unfollow', 'harnesses.list', 'projects.list', 'options.get'];
const FAR = 4102444800; // 2100-01-01 UTC: a reset that never lapses during the run
const window = (label: string, usedPercent: number, extra: object = {}) => ({
  label,
  usedPercent,
  resetsAt: FAR,
  resetsText: null,
  at: Date.now(),
  stale: false,
  ...extra,
});
export const runtime: any = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  onEvent: () => () => {},
  features: async () => ['phone'],
  start: async () => {},
  connect: async () => {},
  send: () => {},
  request: async (method: string, p: any) => {
    if (method === 'chats.recent') return { chats: [] };
    if (method === 'machine.hello') return { capabilities: { methods, permissionCeiling: 'auto-review' } };
    if (method === 'harnesses.list') return { harnesses: [] };
    if (method === 'projects.list') return { projects: [] };
    if (method === 'usage.get') {
      return {
        scope: 'local',
        accounts: [
          {
            harness: 'claude',
            account: 'work',
            label: 'Work',
            active: true,
            state: 'available',
            windows: [window('5-hour', 25 + (p?.refresh ? 10 : 0)), window('Weekly', 60, { resetsAt: null, resetsText: 'Friday 9 AM' })],
          },
          { harness: 'codex', account: 'personal', label: 'Personal', active: false, state: 'available', windows: [window('Weekly', 10)] },
          { harness: 'codex', account: 'spare', label: 'Spare', active: false, state: 'signin', windows: [] },
        ],
      };
    }
    return {};
  },
};
export const media: any = {
  recent: async () => ({ access: 'full', photos: [] }),
  manageLimited: async () => {},
  library: async () => ({ picked: [], refused: [] }),
  camera: async () => null,
  photos: async () => [],
  files: async () => [],
  startRecording: async () => {},
  stopRecording: async () => ({ base64: '', mime: 'audio/wav' }),
  cancelRecording: async () => {},
  level: () => null,
};
