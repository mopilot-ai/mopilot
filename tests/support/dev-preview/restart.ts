// Real recipe production with fake process and port boundaries for restart ordering tests.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
const require = createRequire(import.meta.url);
export const { DevPreviews } = require('../../../electron/capabilities/browser/devPreview.cjs');
export const url = 'http://127.0.0.1:4317/';

export async function savedPreview(t: TestContext) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-preview-'));
  const stateFile = path.join(cwd, 'previews.json');
  const instances: any[] = [];
  const spawned: any[] = [];
  t.after(() => {
    for (const p of instances) {
      p.stopAll();
      p.killNow();
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const spawn = (file: string, args: string[], options: any) => {
    const p: any = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 2 ** 28,
      kill: () => queueMicrotask(() => p.emit('exit', null, 'SIGTERM')),
    });
    spawned.push({ file, args, options, proc: p });
    return p;
  };
  const create = (o: any = {}) => {
    const p = new DevPreviews({ stateFile, spawn, pollMs: 1, probe: async () => true, ...o });
    instances.push(p);
    return p;
  };
  const first = create();
  const s = first.start('chat', { name: 'web', run: ['node', 'server.js'], display: 'node server.js', cwd, project: cwd, url });
  await first.waitReady(s);
  first.stopAll({ preserveSaved: true });
  return { create, s, first, stateFile, cwd, spawned };
}
