// Shared computer-use policy modules, fake helper/controller, grant stores and permission request fixtures.
import { test, mock } from 'node:test';

import assert from 'node:assert/strict';

import { createRequire } from 'node:module';

import fs from 'node:fs';

import os from 'node:os';

import path from 'node:path';

mock.module('electron', { exports: {} });

const require = createRequire(import.meta.url);

const policy = require('../../../electron/capabilities/contract/policy.cjs');

const { GrantStore } = require('../../../electron/capabilities/grants.cjs');

const { ApprovalBroker } = require('../../../electron/capabilities/contract/approvals.cjs');

const { ComputerUse, elementList, toPoints } = require('../../../electron/capabilities/tools/computer.cjs');

const { setupComputerUse } = require('../../../electron/capabilities/computerUse.cjs');

const { Registry } = require('../../../electron/capabilities/contract/registry.cjs');

const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes' };

const MAIL = { bundleId: 'com.apple.mail', name: 'Mail' };

function fakeChats() {
  const meta = new Map<string, any>();
  return {
    get: (id: string) => (meta.has(id) ? { meta: meta.get(id) } : null),
    patchMeta: (id: string, patch: any) => {
      meta.set(id, { ...(meta.get(id) ?? {}), ...patch });
      return true;
    },
    meta,
  };
}

function fakeController() {
  const approvals = new Map<string, any[]>();
  return {
    approvals,
    addApproval(chatId: string, a: any) {
      approvals.set(chatId, [...(approvals.get(chatId) ?? []), a]);
    },
    resolveApproval(id: string) {
      for (const [c, list] of approvals)
        approvals.set(
          c,
          list.filter((a) => a.id !== id),
        );
      return true;
    },
  };
}

function fakeHelper(target = { pid: 7, bundleId: 'com.apple.Notes', name: 'Notes' }) {
  const calls: { method: string; args: any }[] = [];
  const snap = {
    app: { pid: 7, bundleId: 'com.apple.Notes', name: 'Notes' },
    root: {
      id: '0',
      role: 'AXApplication',
      title: 'Notes',
      children: [{ id: '0.0', role: 'AXButton', title: 'Delete', frame: { x: 100, y: 50, w: 20, h: 10 } }],
    },
  };
  const rec =
    (method: string, out: any = { ok: true }) =>
    async (...args: any[]) => (calls.push({ method, args }), out);
  const h = {
    calls,
    target: target as any,
    running: true,
    start: rec('start', {}),
    glowStart: rec('glowStart', {}),
    glowStop: rec('glowStop', {}),
    targetInfo: async (p: any) => (calls.push({ method: 'targetInfo', args: [p] }), h.target),
    screenshot: rec('screenshot', { png: 'iVBORw0K', width: 200, height: 100, display: { x: 0, y: 0 }, pixelsPerPoint: 2 }),
    axSnapshot: rec('axSnapshot', snap),
    permissionStatus: rec('permissionStatus', { accessibility: true, screenRecording: true }),
    acquireControl: rec('acquireControl', {}),
    releaseControl: rec('releaseControl', {}),
    resumeControl: rec('resumeControl', {}),
    click: rec('click'),
    type: rec('type'),
    key: rec('key'),
    scroll: rec('scroll'),
  };
  return h;
}

function rig(
  o: {
    modality?: string | null;
    permission?: string;
    unattended?: string | null;
    scheduled?: any;
    harness?: string;
    acp?: any;
    unattendedAllowed?: boolean;
    bare?: boolean;
    onActivity?: (chatId: string, activity: any) => void;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-tools-'));
  const helper = fakeHelper();
  const ctl = fakeController();
  const broker = new ApprovalBroker({ controller: ctl });
  const grants = new GrantStore({ file: path.join(dir, 'computer.json'), chats: fakeChats() });
  const paused: any[] = [];
  const cu = new ComputerUse({
    helper,
    onActivity: o.onActivity,
    grants,
    broker,
    session: () => ({
      modality: o.modality ?? 'image',
      permission: o.permission ?? 'default',
      acp: o.acp ?? null,
      scheduled: o.scheduled ?? null,
    }),
    harness: () => o.harness ?? 'claude',
    unattendedAllowed: () => o.unattendedAllowed ?? true,
    unattended: async () => o.unattended ?? null,
    ...(o.bare ? {} : { onUnattended: (chatId: string, e: any) => paused.push({ chatId, ...e }) }),
    settleMs: 0,
  });
  const reg = new Registry();
  for (const t of cu.tools()) reg.register(t);
  // answers the next card in c1 when it appears
  const answerNext = (result: any) =>
    new Promise<any>((resolve) => {
      const tick = () => {
        const card = ctl.approvals.get('c1')?.[0];
        if (!card) return setTimeout(tick, 1);
        broker.answer(card.id, result);
        resolve(card);
      };
      tick();
    });
  return { helper, ctl, broker, grants, cu, reg, answerNext, paused, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const permissionDenied = (kind = 'screenRecording') =>
  Object.assign(new Error(`${kind} permission not granted`), { reason: 'permission_denied' });

function permissionRig() {
  const activity: any[] = [];
  const r = rig({ onActivity: (chatId, value) => activity.push({ chatId, value }) });
  r.grants.grant('c1', NOTES, 'full', 'always');
  const requested: string[] = [];
  return { ...r, requested, activity };
}

function permissionIpcRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-permission-ipc-'));
  const handlers = new Map<string, Function>();
  const broadcasts: any[] = [];
  let enabled = true;
  const runtime = setupComputerUse({
    ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    registry: new Registry(),
    flags: { isEnabled: () => enabled },
    chats: fakeChats(),
    controller: fakeController(),
    sessions: { patch: () => {} },
    userData: dir,
    packaged: false,
    broadcast: (...args: any[]) => broadcasts.push(args),
    stop: async () => {},
  });
  const calls: string[] = [];
  // the helper app is in place (whatever this checkout built)
  Object.defineProperty(runtime.helper, 'installed', { configurable: true, get: () => true });
  runtime.helper.start = async () => (calls.push('start'), {});
  runtime.helper.requestPermission = async (kind: string) => (calls.push(kind), { [kind]: true });
  return {
    runtime,
    calls,
    broadcasts,
    disable: () => {
      enabled = false;
    },
    enable: () => {
      enabled = true;
    },
    thumbnail: (turnId?: string) => handlers.get('computer:workingThumb')!({}, 'chat', 'TextEdit', turnId),
    request: (kind: string) => handlers.get('computer:requestPermission')!({}, kind),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export {
  require,
  test,
  assert,
  fs,
  os,
  path,
  policy,
  GrantStore,
  ApprovalBroker,
  ComputerUse,
  elementList,
  toPoints,
  setupComputerUse,
  Registry,
  NOTES,
  MAIL,
  fakeChats,
  fakeController,
  fakeHelper,
  rig,
  permissionDenied,
  permissionRig,
  permissionIpcRig,
};
