// A scripted runtime and media stand-in for the M3 phone screens.
import { withOutbox } from './outbox-kit';
export const menus = {
  hello: {
    capabilities: {
      methods: ['diff.list', 'diff.read', 'file.read', 'chat.transcribe', 'chat.attach'],
      permissionCeiling: 'auto-review',
      messageIdentity: 1,
    },
  },
  harnesses: {
    harnesses: [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
    ],
  },
  projects: { projects: [{ id: 'app', name: 'App' }] },
  options: (harness: string) => ({
    accounts:
      harness === 'claude'
        ? [
            { id: 'work', label: 'Work' },
            { id: 'old', label: 'Old', loggedIn: false },
          ]
        : undefined,
    models: [
      {
        id: `${harness}-m`,
        label: `${harness} model`,
        efforts: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
        ],
        defaultEffort: 'low',
      },
    ],
    model: `${harness}-m`,
    effort: 'low',
    permission: {
      value: 'default',
      rows: [
        { id: 'default', label: 'Ask', detail: 'Ask first' },
        { id: 'auto-review', label: 'Auto', detail: 'Reviewed', disabled: 'Not for this model' },
        { id: 'full-access', label: 'Bypass', detail: 'No' },
      ],
    },
  }),
};

/** The Mac's reply to one chunk of a stream: progress, and the attachment once the last part is in. */
export const chunkReply = (p: any) => {
  const done = p.index + 1 === p.total;
  return {
    stream: p.stream,
    received: p.index + 1,
    done,
    ...(done && p.purpose === 'file' ? { id: '0123456789abcdef', name: p.name, kind: 'image' } : {}),
  };
};

export function scripted(
  handler: (method: string, params: any) => unknown,
  snap: any = { selectedPair: 'p', generation: 1, phase: 'online' },
) {
  const calls: [string, any][] = [];
  const state = { snap };
  const runtime: any = {
    // the connection fields every real snapshot has, unless a test sets them
    snapshot: () => ({ presence: {}, reconnect: null, ...state.snap }),
    subscribe: () => () => {},
    onEvent: () => () => {},
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      const base: any = {
        'machine.hello': menus.hello,
        'harnesses.list': menus.harnesses,
        'projects.list': menus.projects,
        'options.get': menus.options(params?.harness ?? 'claude'),
        'chat.attach': params?.stream ? chunkReply(params) : undefined,
        'chat.follow': { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] },
        'chat.unfollow': {},
      };
      const answer = handler(method, params);
      return answer === undefined && method in base ? base[method] : answer;
    },
  };
  withOutbox(runtime);
  return { runtime, calls, state };
}

/** What the library picker returns for a test's `library` override: one photo, none (null), a list, or `{ picked, refused }` as it is. */
const chosen = (value: any) =>
  value === null
    ? { picked: [], refused: [] }
    : Array.isArray(value)
      ? { picked: value, refused: [] }
      : value.picked
        ? value
        : { picked: [value], refused: [] };

export function fakeMedia(over: Record<string, any> = {}) {
  const log: string[] = [];
  /** The room the sheet asked the library picker for, one entry per open. */
  const rooms: number[] = [];
  const photo = { name: 'photo.jpg', mime: 'image/jpeg', base64: 'QUJD' };
  const media = {
    library: async (room: number) => (log.push('library'), rooms.push(room), chosen(over.library === undefined ? photo : over.library)),
    camera: async () => {
      log.push('camera');
      if (over.cameraError) throw new Error(over.cameraError);
      return over.camera === undefined ? photo : over.camera;
    },
    recent: async () => (log.push('recent'), over.recent ?? { access: 'full' as const, photos: [] }),
    manageLimited: async () => {
      log.push('manage');
      if (over.manageError) throw new Error(over.manageError);
    },
    photos: async (ids: string[]) => {
      log.push(`photos:${ids.join(',')}`);
      if (over.failPhoto && ids.includes(over.failPhoto)) throw new Error('That photo could not be read.');
      return ids.map((id) => ({ name: `${id}.jpg`, mime: 'image/jpeg', base64: 'QUJD' }));
    },
    files: async () => (log.push('files'), over.files ?? []),
    startRecording: async () => {
      log.push('start');
      if (over.startError) throw new Error(over.startError);
    },
    stopRecording: async () => (log.push('stop'), { base64: 'UklGRg==', mime: 'audio/wav' as const }),
    level: () => (over.level === undefined ? null : over.level),
    cancelRecording: async () => {
      log.push('cancel');
      if (over.cancelError) throw new Error('x');
    },
  };
  return { media, log, rooms };
}
