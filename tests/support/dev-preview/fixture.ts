// Shared project cleanup, process scripts and fakes for dev-preview test groups.
import { test, after } from 'node:test';

import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';

import fs from 'node:fs';

import net from 'node:net';

import os from 'node:os';

import path from 'node:path';

import { createRequire } from 'node:module';
import { previewToolSpecs } from '../tool-specs.ts';

const require = createRequire(import.meta.url);

const dp = require('../../../electron/capabilities/browser/devPreview.cjs');

const {
  DevPreviews,
  createPreviewTools,
  registerPreviewTools,
  paneOpener,
  readLaunchConfigs,
  findLocalUrl,
  portOf,
  probePort,
  stripAnsi,
  PREVIEW_TOOL_NAMES,
  LAUNCH_FILES,
} = dp;

const { Registry } = require('../../../electron/capabilities/contract/registry.cjs');

const { placement } = require('../../../electron/capabilities/contract/hostServers.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpreview-'));

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let dirs = 0;

function project(files: Record<string, any> = {}) {
  const dir = path.join(tmp, `p${dirs++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => any, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('timed out');
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as any;
      s.close(() => resolve(port));
    });
  });

const NODE = process.execPath;

const SERVE_PRINTED = `const s = require('http').createServer((q, r) => r.end('ok')); s.listen(0, '127.0.0.1', () => { console.log('\\u001b[32m  Local: http://127.0.0.1:' + s.address().port + '/\\u001b[0m'); console.error('warn: something failed'); });`;

const SERVE_PORT = `require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('up ' + process.env.MOPILOT_X));`;

function fakeTabs() {
  const log: any[] = [];
  const list: any[] = [];
  let n = 0;
  return {
    log,
    list: (chatId: string) => list.filter((t) => t.chatId === chatId),
    create: async (chatId: string, o: any) => {
      const t = { id: `tab_${++n}`, chatId };
      list.push(t);
      log.push(['create', chatId, o]);
      return t;
    },
    mark: (chatId: string, id: string, status: string) => log.push(['mark', id, status]),
    select: (chatId: string, id: string) => log.push(['select', id]),
    run: async (tab: any, fn: any) => fn(),
    ready: async (tab: any, chatId: string) => log.push(['ready', tab.id, chatId]),
    navigate: async (tab: any, url: string) => log.push(['navigate', tab.id, url]),
    drop: (id: string) =>
      list.splice(
        list.findIndex((t) => t.id === id),
        1,
      ),
  };
}

function harness(o: any = {}) {
  const procs: any[] = [];
  let probeAnswer: (port: number) => boolean = o.probe ?? (() => false);
  const previews = new DevPreviews({
    pollMs: 1,
    platform: o.platform,
    probe: async (port: number) => probeAnswer(port),
    spawn: (file: string, args: string[], opts: any) => {
      const proc: any = Object.assign(new EventEmitter(), {
        file,
        args,
        opts,
        pid: 2 ** 22 + procs.length,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill() {},
      });
      procs.push(proc);
      return proc;
    },
  });
  const opened: any[] = [];
  const confirms: any[] = [];
  let answer = true;
  const h: any = {
    procs,
    previews,
    opened,
    confirms,
    project: o.project ?? null,
    anchorValue: 'ask',
    setProbe: (fn: any) => (probeAnswer = fn),
    answer: (v: boolean) => (answer = v),
  };
  const tools = createPreviewTools({
    previews,
    projectOf: async () => h.project,
    open: async (chatId: string, url: string, opts: any) => {
      opened.push([chatId, url, opts]);
      if (o.openFails) throw Object.assign(new Error('The user did not allow http://localhost:5173.'), { code: 'denied' });
      return { id: opts.tabId || 'tab_new' };
    },
    anchor: o.noAnchor ? undefined : (o.anchor ?? (() => h.anchorValue)),
    confirm: o.noConfirm ? null : async (ctx: any, req: any) => (confirms.push([ctx.chatId, req]), answer),
    enabled: o.enabled,
    readyMs: o.readyMs ?? 2000,
    platform: o.platform,
    readFile: o.readFile,
  });
  h.call = (name: string, args: any = {}, ctx: any = {}) =>
    tools.find((x: any) => x.name === name).handler(args, { chatId: 'c', segmentId: 's', ...ctx });
  h.tools = tools;
  return h;
}

const CONFIG = (port = 5173) => ({
  '.claude/launch.json': { configurations: [{ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port }] },
});

export {
  test,
  after,
  assert,
  EventEmitter,
  fs,
  net,
  os,
  path,
  createRequire,
  require,
  dp,
  DevPreviews,
  createPreviewTools,
  registerPreviewTools,
  previewToolSpecs,
  paneOpener,
  readLaunchConfigs,
  findLocalUrl,
  portOf,
  probePort,
  stripAnsi,
  PREVIEW_TOOL_NAMES,
  LAUNCH_FILES,
  Registry,
  placement,
  tmp,
  dirs,
  project,
  sleep,
  until,
  freePort,
  NODE,
  SERVE_PRINTED,
  SERVE_PORT,
  fakeTabs,
  harness,
  CONFIG,
};
