// Shared Electron updater mocks, response controls, platform reset and asynchronous unit fixtures.
// electron/updates/updater.cjs: the Updater's lifecycle against a faked Electron — on macOS the feed, the download and its
// hand-off to Squirrel (team signature, /Applications, feed headers, schedule, idle restart); on Windows the feed polled.
import { mock, beforeEach, afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { deferred } from '../async-scenarios.ts';

const calls: any[] = [];
const autoUpdater: any = Object.assign(new EventEmitter(), {
  setFeedURL: (o: any) => calls.push(['feed', o]),
  checkForUpdates: () => calls.push(['checkForUpdates']),
  quitAndInstall: () => calls.push(['quitAndInstall']),
});
const app: any = {
  isPackaged: true,
  getVersion: () => '1.2.3',
  getPath: (name: string) => `/nonexistent-mopilot-test/${name}`,
  inApps: true,
  isInApplicationsFolder: () => app.inApps,
  moveToApplicationsFolder: () => calls.push(['move']),
  quit: () => calls.push(['quit']),
};
let dialogResponse = 0;
let lastDialog: any = null;
const dialog = { showMessageBox: async (o: any) => ((lastDialog = o), calls.push(['dialog', o.message]), { response: dialogResponse }) };
let fetchImpl: (url: string, o: any) => Promise<any> = async () => ({ status: 204 });
const net = { fetch: (url: string, o: any) => (calls.push(['fetch', url, o.headers]), fetchImpl(url, o)) };
let openResult: Promise<void> = Promise.resolve();
const shell = { openExternal: (url: string) => (calls.push(['open', url]), openResult) };
mock.module('electron', { exports: { app, autoUpdater, dialog, net, shell } });

const RELEASE_SIGNATURE =
  'Authority=Developer ID Application: MoPilot LLC (AB12CD34EF)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=AB12CD34EF\n';
let codesignStderr = RELEASE_SIGNATURE;
const execFile = (cmd: string, args: string[], _o: any, cb: Function) => {
  calls.push(['exec', cmd, ...args]);
  cb(null, '', codesignStderr);
};
mock.module('node:child_process', { namedExports: { execFile } });

const { Updater } = createRequire(import.meta.url)('../../../electron/updates/updater.cjs');
// the MoPilot service's restricted feed, as a build with the service has it (electron/platform/mopilotEndpoints.cjs)
const API_BASE = 'https://mopilot.example.test';
const ENDPOINTS = {
  API_BASE,
  updateFeedUrl: (platform: string, arch: string, version: string, query: URLSearchParams) =>
    `${API_BASE}/api/update/${platform}/${arch}/${version}?${query}`,
};
const HOST = new URL(API_BASE).host;
const { STABLE_FEED_URL } = createRequire(import.meta.url)('../../../shared/stableUpdates.cjs');

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

// the feed offers an update on macOS; Windows tests set their own replies
const ZIP = 'https://example.test/dl/MoPilot-2.0.0-arm64.zip';
const feedBody = (b: any) => ({ status: 200, ok: true, json: async () => b });
const offer = async (url = STABLE_FEED_URL) => {
  if (url === STABLE_FEED_URL)
    return feedBody({
      schema: 1,
      releases:
        process.platform === 'win32'
          ? []
          : [
              {
                version: '2.0.0',
                platform: 'darwin',
                arch: process.arch,
                rolloutPct: 100,
                url: ZIP,
                notes: 'n',
                pub_date: '2026-10-15T00:00:00Z',
              },
            ],
    });
  return process.platform === 'win32' ? { status: 204 } : feedBody({ url: ZIP, name: '2.0.0', notes: 'n' });
};
const LOOPBACK = 'http://127.0.0.1:9/t/feed.json';
const fakeDownload = async (o: any) => {
  calls.push(['download', o.url, o.headers]);
  o.onProgress(10, 10);
  return '/tmp/update.zip';
};
const fakeServe = async (o: any) => {
  calls.push(['serve', o.update]);
  return { feedUrl: LOOPBACK, close: () => calls.push(['close']) };
};

beforeEach(() => {
  calls.length = 0;
  autoUpdater.removeAllListeners();
  app.isPackaged = true;
  app.inApps = true;
  dialogResponse = 0;
  codesignStderr = RELEASE_SIGNATURE;
  fetchImpl = offer;
  openResult = Promise.resolve();
  setPlatform('darwin');
});
afterEach(() => setPlatform(realPlatform));

const make = (o: any = {}) => {
  const seen: any[] = [];
  const u = new Updater({
    installId: 'iid-1',
    broadcast: (s: any) => seen.push(s),
    team: async () => 'TEAM',
    download: fakeDownload,
    serve: fakeServe,
    endpoints: ENDPOINTS,
    ...o,
  });
  return { u, seen };
};

/** A macOS check through its download, to where Squirrel unpacks the update. */
async function checked(u: any, o?: any) {
  await u.check(o);
  await u.downloadWork;
  return u.state;
}

const responses = {
  get dialogResponse() {
    return dialogResponse;
  },
  set dialogResponse(value: typeof dialogResponse) {
    dialogResponse = value;
  },
  get fetchImpl() {
    return fetchImpl;
  },
  set fetchImpl(value: typeof fetchImpl) {
    fetchImpl = value;
  },
  get openResult() {
    return openResult;
  },
  set openResult(value: typeof openResult) {
    openResult = value;
  },
  get codesignStderr() {
    return codesignStderr;
  },
  set codesignStderr(value: typeof codesignStderr) {
    codesignStderr = value;
  },
};

export {
  dialog,
  mock,
  EventEmitter,
  calls,
  autoUpdater,
  app,
  lastDialog,
  Updater,
  API_BASE,
  ENDPOINTS,
  HOST,
  setPlatform,
  ZIP,
  feedBody,
  offer,
  LOOPBACK,
  fakeDownload,
  fakeServe,
  make,
  checked,
  deferred,
  responses,
};
