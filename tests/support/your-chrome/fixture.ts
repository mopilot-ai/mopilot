import { extensionWire } from '../extension-wire.ts';
// Shared imports and fake utility processes for Your Chrome test groups.
import { test } from 'node:test';

import assert from 'node:assert/strict';

import fs from 'node:fs';

import os from 'node:os';

import path from 'node:path';

import { spawn } from 'node:child_process';

import { EventEmitter } from 'node:events';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  ChromeChannel,
  chromeTools,
  spawnSpec,
  pageUrl,
  sageName,
  NEEDS,
  HOST,
} = require('../../../electron/capabilities/browser/extension.cjs');

const { BrowserControl, effectiveChannel } = require('../../../electron/capabilities/browser/control.cjs');

const { ChromeTokens } = require('../../../electron/capabilities/browser/chromeToken.cjs');

const { OriginGrants } = require('../../../electron/capabilities/browser/origins.cjs');

const { Registry } = require('../../../electron/capabilities/contract/registry.cjs');

const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeFork(o: { onCall?: (name: string, args: any) => any; failStart?: boolean } = {}) {
  const children: any[] = [];
  const fork = (modulePath: string, args: string[], options: any) => {
    const child: any = new EventEmitter();
    Object.assign(child, { modulePath, args, options, got: [], started: null, killed: false, stopped: false });
    child.stderr = new EventEmitter();
    const reply = (msg: any) => setImmediate(() => child.emit('message', { type: 'out', data: JSON.stringify(msg) + '\n' }));
    child.postMessage = (m: any) => {
      if (m.type === 'start') child.started = m.args;
      else if (m.type === 'stop') {
        child.stopped = true;
        setImmediate(() => child.emit('exit', 0));
      } else if (m.type === 'in') {
        const msg = JSON.parse(m.data);
        child.got.push(msg);
        if (msg.method === 'initialize') {
          if (o.failStart) return setImmediate(() => child.emit('exit', 1));
          reply({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'Playwright' } } });
        } else if (msg.method === 'tools/list')
          reply({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                { name: 'browser_navigate', inputSchema: { type: 'object' } },
                { name: 'browser_evaluate', inputSchema: { type: 'object' } },
              ],
            },
          });
        else if (msg.method === 'tools/call')
          reply({
            jsonrpc: '2.0',
            id: msg.id,
            result: o.onCall ? o.onCall(msg.params.name, msg.params.arguments) : { content: [{ type: 'text', text: 'ok' }] },
          });
      }
    };
    child.kill = () => {
      child.killed = true;
      child.emit('exit', null);
    };
    children.push(child);
    extensionWire(child);
    return child;
  };
  return { fork, children };
}

export {
  test,
  assert,
  fs,
  os,
  path,
  spawn,
  EventEmitter,
  createRequire,
  require,
  ChromeChannel,
  chromeTools,
  spawnSpec,
  pageUrl,
  sageName,
  NEEDS,
  HOST,
  BrowserControl,
  effectiveChannel,
  ChromeTokens,
  OriginGrants,
  Registry,
  tick,
  fakeFork,
};
