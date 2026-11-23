// A fake SDK query and live session for the Remote Control service tests (electron/harness/claude/remoteControl.cjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const require = createRequire(import.meta.url);
export const { createRemoteControl, linkOf, UNAVAILABLE } = require('../../electron/harness/claude/remoteControl.cjs');
export const { recentIgnored, clearIgnored, noteIgnored } = require('../../electron/ignored.cjs');
const { readStoreFile, writePrivate } = require('../../electron/platform/fsutil.cjs');

// as electron/harness/claude/sessions.cjs gives it
export const io = {
  read: (file: string) => readStoreFile(file, 'Remote Control choices', (d: any) => !!d && typeof d === 'object' && !Array.isArray(d)).data,
  write: writePrivate,
};

export const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-rc-'));
let n = 0;
export const fileOf = () => path.join(dir, `rc-${++n}.json`);
export const link = (id = 'a') => ({
  session_url: `https://claude.ai/code/session_${id}`,
  bridge_session_id: `cse_${id}`,
  bridge_epoch: 1,
});
export const tick = () => new Promise((r) => setImmediate(r));

/** A deferred answer the test settles by hand. */
export function later<T = any>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

export function setup(
  o: {
    file?: string | null | (() => string | null);
    requestMs?: number;
    ticking?: boolean;
    /** the network: true unless a test says otherwise */
    net?: { up: boolean };
    /** the clock a test moves by hand */
    clock?: { t: number };
    /** makes publishing throw while it returns true */
    emitFails?: () => boolean;
    /** the state's listener for the computer waking: it returns how to stop */
    onResume?: (fn: () => void) => (() => void) | undefined;
  } = {},
) {
  const events: any[] = [];
  const live = new Set<any>();
  const state: any = {
    emit: (e: any) => {
      if (o.emitFails?.()) throw new Error('window gone');
      events.push(e);
    },
    ...(o.onResume ? { onResume: o.onResume } : {}),
  };
  const lifetime = { active: (s: any) => live.has(s) };
  const rc = createRemoteControl(state, {
    lifetime,
    file: o.file === undefined ? fileOf() : o.file,
    io,
    note: noteIgnored,
    requestMs: o.requestMs ?? 1000,
    online: () => o.net?.up ?? true,
    now: () => o.clock?.t ?? Date.now(),
    ticking: o.ticking ?? false,
  });
  /** a live session whose query records each enableRemoteControl and answers by `answer` */
  const session = (extra: any = {}) => {
    const calls: any[][] = [];
    const s: any = {
      key: 'claude:x',
      sessionId: 'x',
      cwd: '/work/project',
      q: {
        calls,
        answer: (..._a: any[]): any => link(),
        enableRemoteControl: (...a: any[]) => (calls.push(a), s.q.answer(...a)),
        initializationResult: async () => ({ remote_control_available: true }),
      },
      ...extra,
    };
    live.add(s);
    return s;
  };
  return { rc, events, live, session, state };
}
