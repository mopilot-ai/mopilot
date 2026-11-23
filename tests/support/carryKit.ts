// Shared setup of the carry tests (tests/hostCodeCarry*.test.ts): a bare remote with a source and a target clone, a Host git over them, and scripted-git and app fakes.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { HostRefusal, createHostFs } from '../../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostGit } from '../../host/src/hostGit.mjs';
const require = createRequire(import.meta.url);
const { createCodeTransfer } = require('../../electron/host/codeTransfer.cjs');
export { HostRefusal, createHostGit };
export const ids = { n: 0 };

export const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-carry-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
export const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
export const roots = path.join(base, 'roots');
fs.mkdirSync(roots);

/** A bare remote, a source clone with one commit on `main`, and a target clone of the same, both inside the roots. */
export function world() {
  const id = ids.n++;
  const remote = path.join(base, `remote${id}.git`);
  run(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const source = path.join(roots, `source${id}`);
  run(base, 'clone', '-q', remote, source);
  run(source, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(source, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(source, 'b.txt'), 'two\n');
  run(source, 'add', '.');
  run(source, 'commit', '-qm', 'one');
  run(source, 'push', '-q', 'origin', 'main');
  const target = path.join(roots, `target${id}`);
  run(base, 'clone', '-q', remote, target);
  return { remote, source, target };
}
export const hostFs = createHostFs({ roots: [roots] });
export const host = createHostGit({ hostFs });
export const key = (s: string) => `carry-${s}-${ids.n}`;
export const refusal = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: any) => e instanceof HostRefusal && e.code === code, code);
export const branches = (remote: string) =>
  run(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/mopilot').split('\n').filter(Boolean);

export type Reply = { ok: boolean; stdout?: string; stderr?: string };
export function script(replies: Record<string, Reply | ((args: string[]) => Reply)>) {
  const calls: string[][] = [];
  const run = async (args: string[], _o: unknown = {}) => {
    calls.push(args);
    const verb = args.find((a) => !a.startsWith('--no-')) as string;
    const r = replies[args.join(' ')] ?? replies[verb] ?? { ok: true };
    const out = typeof r === 'function' ? r(args) : r;
    return { stdout: '', stderr: '', ...out };
  };
  return { run, calls };
}
export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);
export const applyBase = {
  'rev-parse --is-inside-work-tree': { ok: true, stdout: 'true' },
  'symbolic-ref --short -q HEAD': { ok: true, stdout: 'main' },
  'rev-parse --verify -q HEAD': { ok: true, stdout: SHA_A },
  'remote get-url origin': { ok: true, stdout: 'https://github.com/a/b' },
  'status --porcelain=v1': { ok: true, stdout: '' },
  'rev-parse --verify -q FETCH_HEAD': { ok: true, stdout: SHA_C },
  [`rev-parse --verify -q ${SHA_C}^`]: { ok: true, stdout: SHA_A },
};
export const req = { branch: 'mopilot/carry/abcdefgh', commit: SHA_C, parent: SHA_A, sourceBranch: 'main' };
export const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: any) => e.name === 'CarryRefusal' && e.code === c, c);

// ---- the app side ----
export function app(o: { push?: () => Promise<any>; apply?: () => Promise<any>; drop?: () => Promise<any> } = {}) {
  const calls: string[] = [];
  const pushes: any[] = [];
  const reports: string[] = [];
  const t = createCodeTransfer({
    inspect: async () => ({ isRepo: false }),
    clone: async () => ({}),
    carry: {
      plan: async (h: string, r: any) => (calls.push(`plan:${h}:${r.path}`), { untracked: ['n.txt'], skipped: ['.env'], files: 3 }),
      push: async (h: string, r: any) => (
        pushes.push(r),
        calls.push(`push:${h}:${r.path}:${r.key}:${r.untracked.join('+')}`),
        o.push ? o.push() : { branch: 'mopilot/carry/k', commit: SHA_C, parent: SHA_A, sourceBranch: 'main', files: 2, skipped: ['.env'] }
      ),
      apply: async (h: string, r: any) => (calls.push(`apply:${h}:${r.path}:${r.branch}:${r.commit}`), o.apply ? o.apply() : { files: 2 }),
      drop: async (h: string, r: any) => (calls.push(`drop:${h}:${r.path}:${r.branch}`), o.drop ? o.drop() : { dropped: true }),
    },
    newKey: () => 'key-minted-01',
    report: (m: string) => reports.push(m),
  });
  return { t, calls, pushes, reports };
}
export const dirtySource = { isRepo: true, remote: 'https://github.com/a/b', branch: 'main', head: SHA_A, dirty: 2 };
export const where = { sourceHostId: 'A', cwd: '/w', targetHostId: 'B', targetPath: '/t' };
