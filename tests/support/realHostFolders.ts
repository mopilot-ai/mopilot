// A machine's folder service over the REAL Host protocol (host/src/protocol.mjs → hostRead/hostFiles/hostWrite) and the real reader (electron/host/folders.cjs), with a real git repository in a folder inside the Host's roots: what the Changes pane gets on a real machine, with no fake reply in between.
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../../host/src/epochs.mjs';
// @ts-ignore: plain ESM without declarations
import { createGuard } from '../../host/src/guard.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostFiles } from '../../host/src/hostFiles.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostRead } from '../../host/src/hostRead.mjs';
// @ts-ignore: plain ESM without declarations
import { parseParams } from '../../shared/host/schema.mjs';
// @ts-ignore: plain ESM without declarations
import { createLedger } from '../../host/src/ledger.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../../host/src/protocol.mjs';
const require = createRequire(import.meta.url);
const { createHostFolders } = require('../../electron/host/folders.cjs');
const { OwnershipStore } = require('../../electron/host/ownership.cjs');

const quiet = { report: () => undefined };

export function realHostFolders() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'real-host-')));
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }), send: async () => ({ turnId: 't' }) };
  const epochs = createEpochStore(path.join(base, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(base, 'l'), quiet) });
  const hostFs = createHostFs({ roots: [root] });
  const hostRead = createHostRead({ hostFs });
  const hostFiles = createHostFiles({ hostFs });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), hostFs });
  /** The Host's own dispatch (host/src/server.mjs answer): the versioned methods go to the protocol session, the read methods of the line protocol to their services. */
  const serve = (conn: any, method: string, params: any) => {
    const p = () => parseParams(method, params);
    if (/^(host|chat|browser|desktop)\./.test(method)) return conn.call(method, params);
    if (method === 'fs.list') return hostFs.list(p());
    if (method === 'fs.tree') return hostFiles.tree(p());
    if (method === 'fs.read') return hostFiles.read(p());
    if (method === 'git.diff') return hostRead.diff(p());
    if (method === 'git.status') return hostRead.status(p());
    throw new Error(`Unknown method ${method}`);
  };
  /** every reply the Host sent, by method, before the app's reader shaped it */
  const raw: Record<string, any> = {};
  const folders = createHostFolders({
    open: async () => {
      const conn = protocol.connection(() => undefined);
      return {
        call: async (method: string, params?: object) => {
          const reply = await serve(conn, method, params);
          raw[method] = reply;
          return reply;
        },
        close: () => undefined,
      };
    },
    store: new OwnershipStore(path.join(base, 'own.json')),
  });
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: r.status, out: r.stdout.trimEnd(), err: r.stderr };
  };
  const must = (cwd: string, ...args: string[]) => {
    const r = git(cwd, ...args);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.err}`);
    return r.out;
  };
  let n = 0;
  /** A repository with one commit; with `conflict`, a merge in progress that stopped on `a.txt` (unmerged, UU). It also holds an untracked text file and a tracked binary one with a change. */
  function repo({ conflict = false } = {}) {
    const dir = path.join(root, `r${n++}`);
    fs.mkdirSync(dir);
    must(dir, 'init', '-q', '--initial-branch=main');
    for (const [k, v] of [
      ['user.name', 't'],
      ['user.email', 't@example.invalid'],
      ['commit.gpgsign', 'false'],
    ])
      must(dir, 'config', k, v);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 0]));
    must(dir, 'add', '.');
    must(dir, 'commit', '-qm', 'one');
    if (conflict) {
      must(dir, 'checkout', '-qb', 'side');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'side\n');
      must(dir, 'commit', '-qam', 'side');
      must(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
      must(dir, 'commit', '-qam', 'main');
      assert.equal(git(dir, 'merge', 'side').status, 1, 'the merge stops on a conflict');
    }
    fs.writeFileSync(path.join(dir, 'pic.bin'), Buffer.from([0, 9, 2, 0]));
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\ny\n');
    return dir;
  }
  return { folders, raw, repo, root, git, must, dispose: () => fs.rmSync(base, { recursive: true, force: true }) };
}
