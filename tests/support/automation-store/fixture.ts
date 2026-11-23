// Shared sandbox task storage and fake Claude Desktop fixtures for automation store unit cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tornWrites } from '../torn-write.ts';

const require = createRequire(import.meta.url);
const { AutomationStore, readFolder, writeTask, runsIn, uniqueId, DESKTOP } = require('../../../electron/platform/automationStore.cjs');
const { parse } = require('smol-toml');

/** A fake Claude Desktop: its tasks, whether it is open, what MoPilot asked of it. */
function fakeDesktop(o: { installed?: boolean; running?: boolean; tasks?: any[]; upsert?: any } = {}) {
  const d: any = {
    open: o.running ?? false,
    tasks: o.tasks ?? [],
    calls: [] as any[],
    installed: () => o.installed ?? true,
    running: async () => d.open,
    list: () => d.tasks,
    upsert: (a: any) => {
      d.calls.push(['upsert', a.id]);
      const r = o.upsert ? o.upsert(a) : { ok: true };
      if (r.ok)
        d.tasks = [
          ...d.tasks.filter((x: any) => x.id !== a.id),
          {
            id: a.id,
            name: a.name,
            prompt: a.prompt,
            rrule: a.rrule,
            status: a.status,
            harness: 'claude',
            version: 1,
            kind: 'cron',
            created_at: 1,
          },
        ];
      return r;
    },
    remove: (id: string) => {
      d.calls.push(['remove', id]);
      d.tasks = d.tasks.filter((x: any) => x.id !== id);
      return true;
    },
  };
  return d;
}

function setup(t: any, desktop = fakeDesktop()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1000;
  const logs: string[] = [];
  const store = new AutomationStore({
    codexDir: () => path.join(root, 'codex'),
    mopilotDir: () => path.join(root, 'mopilot'),
    codexApp: {},
    desktop,
    now: () => clock,
    log: (m: string) => logs.push(m),
  });
  const read = (home: string, id: string) => parse(fs.readFileSync(path.join(root, home, id, 'automation.toml'), 'utf8'));
  const has = (home: string, id: string) => fs.existsSync(path.join(root, home, id));
  return { root, store, desktop, logs, read, has, tick: (ms = 1) => (clock += ms) };
}
const base = { version: 1, kind: 'cron', prompt: 'p', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' };

export {
  test,
  assert,
  DESKTOP,
  fakeDesktop,
  setup,
  base,
  fs,
  path,
  require,
  AutomationStore,
  writeTask,
  tornWrites,
  readFolder,
  runsIn,
  uniqueId,
};
