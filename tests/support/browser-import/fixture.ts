// Shared fake cookie session, safe storage, importer world, and temporary-reader fixtures for browser import unit cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { siteOf, sensitiveReason, groupCookies } = require('../../../electron/capabilities/browser/import/sites.cjs');
const { cookieUrl, setDetails, writeCookies, ImportLedger } = require('../../../electron/capabilities/browser/import/cookies.cjs');
const { BrowserImporter, KINDS } = require('../../../electron/capabilities/browser/import/importer.cjs');
const { createImporter } = require('../../../electron/capabilities/browser/import/service.cjs');
const { createBrowserData } = require('../../../electron/capabilities/browser/data.cjs');
const { ImportError } = require('../../../electron/capabilities/browser/import/errors.cjs');
const { deriveKey, encryptValue } = require('../../../shared/chromiumCrypto.cjs');
const { CredentialStore } = require('../../../electron/capabilities/browser/credentialStore.cjs');
/** A stand-in for Electron safeStorage: reversible, so a test can read back what was stored. */
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4),
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browser-import-test-'));
const T0 = Date.UTC(2026, 9, 1);

const cookie = (o: any = {}) => ({
  host: '.example.com',
  name: 'sid',
  value: 'v',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  expires: T0 / 1000 + 86400,
  hostOnly: false,
  ...o,
});

function fakeSession() {
  const log: any[] = [];
  const stored = new Map<string, any>();
  const ses: any = {
    log,
    stored,
    cookies: {
      set: async (d: any) => {
        if (d.name === 'bad') throw new Error('refused');
        log.push(['set', d.name]);
        stored.set(`${d.url}|${d.name}`, d);
      },
      remove: async (url: string, name: string) => {
        if (name === 'stuck') throw new Error('busy');
        log.push(['remove', url, name]);
        stored.delete(`${url}|${name}`);
      },
      flushStore: async () => log.push(['flush']),
    },
  };
  return ses;
}

// --------------------------------------------------------------- the importer

function world(o: any = {}) {
  const dir = tmp();
  const data = createBrowserData({ userData: () => dir, now: () => T0 });
  const ses = fakeSession();
  const calls: any[] = [];
  const events: any[] = [];
  const files: (string | null)[] = [];
  const chrome = {
    id: 'chrome',
    name: 'Google Chrome',
    kind: 'chromium',
    keychainService: 'Chrome Safe Storage',
    status: 'ready',
    profiles: [{ id: 'Default', name: 'Work', path: '/p/Default' }],
  };
  const sources = o.sources ?? [
    chrome,
    { ...chrome, id: 'arc', name: 'Arc' },
    {
      ...chrome,
      id: 'safari',
      name: 'Safari',
      kind: 'safari',
      keychainService: null,
      profiles: [{ id: 'Safari', name: 'Safari', path: '/s' }],
    },
    { ...chrome, id: 'old', status: 'not_installed' },
    { ...chrome, id: 'blocked', status: 'needs_full_disk_access' },
  ];
  const reader = (name: string) => ({
    bookmarks: async (p: any) => (
      calls.push([name, 'bookmarks', p.id]),
      o.bookmarks ? o.bookmarks() : [{ title: 'Docs', url: 'https://docs.test/', folderPath: ['Bar'] }]
    ),
    history: async (p: any) => (
      calls.push([name, 'history', p.id]),
      o.history ? o.history() : [{ url: 'https://h.test/', title: 'H', lastVisit: T0 - 1000, visitCount: 2 }]
    ),
    cookies: async (p: any, key: any) => {
      calls.push([name, 'cookies', p.id, key ? 'key' : 'nokey']);
      if (o.cookies) return o.cookies();
      return {
        cookies: [cookie({ name: 'a' }), cookie({ name: 'b', host: '.chase.com' }), cookie({ name: 'c', host: '.news.test' })],
        stats: {},
      };
    },
    passwords: async (p: any, key: any, opts: any) => {
      calls.push([name, 'passwords', p.id, key ? 'key' : 'nokey']);
      files.push(opts?.file ?? null);
      if (o.passwords) return o.passwords();
      return {
        logins: [
          { origin: 'https://www.example.com', username: 'me', password: 'pw1', usedAt: 1 },
          { origin: 'https://login.chase.com', username: 'bank', password: 'pw2', usedAt: 1 },
        ],
        stats: {},
      };
    },
  });
  const keyBuf = Buffer.from('0123456789abcdef');
  const loginStore = new CredentialStore({ file: path.join(dir, 'logins.json'), safeStorage: o.noSafe ? null : fakeSafe });
  const importer = new BrowserImporter({
    sources: () => sources,
    readers: { chromium: reader('chromium'), safari: reader('safari') },
    key: async (service: string) => {
      calls.push(['key', service]);
      if (o.keyError) throw o.keyError;
      if (o.keyHook) await o.keyHook();
      return keyBuf;
    },
    history: data.history,
    bookmarks: data.bookmarks,
    session: () => ses,
    logins: () => loginStore,
    ledger: new ImportLedger({ file: path.join(dir, 'ledger.json'), now: () => T0 }),
    broadcast: o.noBroadcast ? undefined : (c: string, p: any) => events.push([c, p]),
    jobMs: o.jobMs,
  });
  return { importer, data, ses, calls, events, keyBuf, loginStore, files };
}

export {
  test,
  assert,
  fs,
  path,
  siteOf,
  sensitiveReason,
  groupCookies,
  cookieUrl,
  setDetails,
  writeCookies,
  ImportLedger,
  tmp,
  T0,
  cookie,
  fakeSession,
  KINDS,
  ImportError,
  world,
  DatabaseSync,
  createImporter,
  createBrowserData,
  deriveKey,
  encryptValue,
};
