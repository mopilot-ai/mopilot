// Scratch native repro uses production navigation/screens/outbox; only account, media and Mac transport are fake.
import { registerRootComponent } from 'expo';
import { MobileApp } from './src/MobileApp';
import { sha256 } from '@noble/hashes/sha256';
import { createOutbox, sendParams } from './src/outbox';
import { createMessageIdentity, IMAGE_UPDATE } from './src/remote/messageIdentity';
import type { MobileRuntime, MobileSnapshot } from './src/contracts';
import type { Media } from './src/platform/media';

const origin = '__NATIVE_SEND_ORIGIN__';
/** A 1x1 PNG: the one photo the fake library hands over (the Mac keeps only its size and name). */
const PHOTO = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// message correlation is learned from the Mac's machine.hello, as in the production runtime; this phone has one pair
const identity = createMessageIdentity(sha256, () => 'pair');
const listeners = new Set<() => void>();
const eventListeners = new Set<Parameters<MobileRuntime['onEvent']>[0]>();
let cursor = 0;
let polling = false;
let timer: ReturnType<typeof setInterval> | undefined;
let nextId = 0;
let snapshot: MobileSnapshot = {
  phase: 'online',
  generation: 1,
  user: { id: 'isolated-send' },
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
async function rpc(method: string, params: Record<string, unknown>) {
  const response = await fetch(`${origin}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const value = await response.json();
  if (value.error) throw new Error(value.error);
  return value;
}
function request(method: string, params: Record<string, unknown> = {}) {
  const answer = rpc(method, params);
  if (method === 'machine.hello') identity.observe('pair', answer, () => true);
  return answer;
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch(`${origin}/events?after=${cursor}`);
    const events = await response.json();
    for (const event of events) {
      cursor += 1;
      eventListeners.forEach((listener) => listener(event));
    }
  } finally {
    polling = false;
  }
}
const box = createOutbox({
  online: () => true,
  ready: async () => true,
  idempotent: () => true,
  identity: (item, id) => identity.id('chat.send', item.chatId, id, item.pairId),
  lost: () => false,
  newId: () => `native-send-${++nextId}`,
  now: Date.now,
  send: (item) =>
    item.images && !identity.supports(item.pairId)
      ? Promise.reject(new Error(IMAGE_UPDATE))
      : request('chat.send', { ...sendParams(item), sendId: item.id }),
  onChange: (outbox) => {
    snapshot = { ...snapshot, outbox };
    listeners.forEach((listener) => listener());
  },
});
const runtime = {
  snapshot: () => snapshot,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  start: async () => {
    if (!timer)
      timer = setInterval(() => {
        void poll();
      }, 100);
  },
  features: async () => ['phone'],
  onEvent: (listener: Parameters<MobileRuntime['onEvent']>[0]) => {
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  },
  request,
  messageIdentity: identity.id,
  send: (chatId: string, text: string, attachments: string[] = [], skills: string[] = [], _momo?: true, pictures: string[] = []) => {
    if (pictures.length && !identity.supports('pair')) throw new Error(IMAGE_UPDATE);
    return box.add({ pairId: 'pair', chatId, text, attachments, skills }, pictures);
  },
  cancelSend: box.cancel,
  editSend: box.edit,
  retrySend: box.retry,
} as MobileRuntime;
const media: Media = {
  recent: async () => ({ access: 'denied', photos: [] }),
  manageLimited: async () => {},
  photos: async () => [],
  files: async () => [],
  library: async () => ({ picked: [{ name: 'native-photo.png', mime: 'image/png', base64: PHOTO }], refused: [] }),
  camera: async () => null,
  startRecording: async () => {},
  stopRecording: async () => ({ base64: '', mime: 'audio/wav' }),
  cancelRecording: async () => {},
  level: () => null,
};
registerRootComponent(() => <MobileApp runtime={runtime} media={media} />);
