// Shared pieces of the remote machines tests: reply checks, a registry row, and Host's phone facade as a fake that records every call it got.
import assert from 'node:assert/strict';

export const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
export const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, JSON.stringify(r.result));
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};
export const refusal = (message: string, code: string) => Object.assign(new Error(message), { code });

export const row = (o: object = {}) => ({
  id: 'ssh:box',
  name: 'box',
  status: 'online',
  note: 'SSH · Claude Code',
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
    { id: 'codex', label: 'Codex', state: 'ready', reason: '', lent: true },
    { id: 'gemini', label: 'Gemini', state: 'ready', reason: '', lent: true },
    { id: 'fake', label: 'fake', state: 'ready', reason: '' },
  ],
  installable: [],
  lastSeen: 900,
  localNetwork: 'allowed',
  waitingForLogin: null,
  ...o,
});
export const record = {
  harnesses: [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: true, signedIn: false, takesKey: true },
    { id: 'gemini', detected: true, signedIn: false, takesOrg: true },
  ],
};

/** Host's phone facade as a fake: the gate, the rows, and every call it got. */
export function fakeHost(o: Record<string, any> = {}) {
  const calls: any[][] = [];
  const host: any = {
    open: true,
    allowed: () => host.open,
    rows: () => [row()],
    record: (id: string) => (id === 'ssh:box' ? record : null),
    orgCovers: (h: string) => h === 'gemini',
    folders: async (id: string, path?: string) => (
      calls.push(['folders', id, path]), { path: path ?? '/srv', roots: ['/srv'], entries: [{ name: 'a', path: '/srv/a', git: true }] }
    ),
    // `check` (the phone still paired, read again after the machine's folder) is called, not recorded
    start: async ({ check, ...q }: any) => (check(), calls.push(['start', q]), { chatId: 'acp:host-claude:1' }),
    move: async ({ check, ...q }: any) => (check(), void calls.push(['move', q])),
    hostOf: (chatId: string) => (chatId === 'c1' ? 'ssh:box' : 'local'),
    // what a machine row's buttons do, run for a phone: every call is recorded and answered with the operation's name
    agents: Object.fromEntries(
      ['install', 'installCancel', 'signIn', 'signInInput', 'signInCancel', 'status', 'update'].map((name) => [
        name,
        async (...args: any[]) => (calls.push([name, ...args]), { name }),
      ]),
    ),
    ...o,
  };
  return { host, calls };
}
