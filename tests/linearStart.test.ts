// A Linear issue as a chat's start (electron/platform/startSource.cjs routing, electron/app/ipc/linear.cjs): the branch picker's search reaches main's Linear connection, and the IPC keeps the key in main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRef } from '../shared/startRef.mjs';

const require = createRequire(import.meta.url);
const { findStartSource, setLinear } = require('../electron/platform/startSource.cjs');
const { register } = require('../electron/app/ipc/linear.cjs');

const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
  decryptString: (b: Buffer) => Buffer.from(b.toString().replace(/^sealed:/, ''), 'base64').toString(),
};
const KEY = `lin_api_${'y'.repeat(40)}`;

test('startRef names a Linear issue by its key or link; GitHub references come first', () => {
  assert.deepEqual(startRef('ENG-12'), { kind: 'linear', key: 'ENG-12' });
  assert.deepEqual(startRef('https://linear.app/acme/issue/ENG-12/x'), { kind: 'linear', key: 'ENG-12' });
  assert.equal(startRef('#12')?.kind, null);
  assert.equal(startRef('eng-12'), null);
});

test('a Linear reference goes to main’s Linear connection, which may not be ready yet', async () => {
  const run = async () => {
    throw new Error('no git or gh for a Linear issue');
  };
  setLinear(null);
  assert.deepEqual(await findStartSource(run, '/w/app', 'ENG-12'), { ok: false, error: 'Linear isn’t ready yet. Try again in a moment.' });
  const asked: unknown[] = [];
  setLinear({ find: async (text: unknown) => (asked.push(text), { ok: true, kind: 'linear', key: 'ENG-12' }) });
  assert.equal((await findStartSource(run, '/w/app', 'ENG-12')).key, 'ENG-12');
  assert.deepEqual(asked, ['ENG-12']);
  setLinear(null);
});

test('the IPC connects with the user’s key, says only its last four characters, and reads an issue with its text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, (...a: any[]) => any>();
  const fetch = async (_url: string, init: any) => {
    const q = JSON.parse(init.body).query as string;
    const data = q.includes('viewer')
      ? { viewer: { name: 'Pat' } }
      : {
          issue: {
            identifier: 'ENG-12',
            title: 'T',
            url: 'https://linear.app/a/issue/ENG-12/t',
            branchName: 'eng-12-t',
            state: { name: 'Todo', type: 'unstarted' },
            description: 'D',
          },
        };
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  register(
    { handle: (name: string, fn: (...a: any[]) => any) => handlers.set(name, fn) },
    { app: { getPath: () => dir } },
    { safeStorage: safe, fetch },
  );
  const call = (name: string, ...a: unknown[]) => handlers.get(name)!({}, ...a);
  assert.deepEqual(await call('linear:status'), { connected: false, last4: null });
  assert.deepEqual(await call('linear:connect', KEY), { ok: true, name: 'Pat' });
  assert.deepEqual(await call('linear:status'), { connected: true, last4: 'yyyy' });
  const issue = await call('linear:issue', 'ENG-12');
  assert.equal(issue.branch, 'eng-12-t');
  assert.match(issue.context, /Linear issue ENG-12/);
  // the picker's lookup reaches the same connection
  assert.equal((await findStartSource(async () => ({ ok: false }), '/w', 'ENG-12')).key, 'ENG-12');
  assert.deepEqual(await call('linear:disconnect'), { ok: true });
  assert.deepEqual(await call('linear:status'), { connected: false, last4: null });
  setLinear(null);
});

test('the IPC registers with Electron’s own keychain and fetch when none is given', () => {
  const handlers = new Map<string, unknown>();
  register({ handle: (name: string, fn: unknown) => handlers.set(name, fn) }, { app: { getPath: () => os.tmpdir() } });
  assert.deepEqual([...handlers.keys()].sort(), ['linear:connect', 'linear:disconnect', 'linear:issue', 'linear:status']);
  setLinear(null);
});
