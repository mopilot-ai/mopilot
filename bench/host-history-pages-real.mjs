// Package the final checkout's Host for a locked mopilot-bench VM and collect its isolated real-CLI restart/paging proof without touching installed services or accounts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChannel, vmLauncher } from '../scripts/host-accept/channel.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const vm = 'mopilot-bench';
const tag = process.env.MOPILOT_HISTORY_VM_LOCK_TAG;
if (!tag) throw new Error('Run only under an acquired official VM lock, setting MOPILOT_HISTORY_VM_LOCK_TAG.');
const owner = execFileSync(path.join(os.homedir(), 'bench/runner/vmlock.sh'), ['status'], {
  env: { ...process.env, VMLOCK_VM: vm },
  encoding: 'utf8',
}).split('\n')[0];
if (!owner.startsWith(tag + ' ')) throw new Error('The official VM lock does not belong to this run.');
const out = process.argv[2];
if (!out) throw new Error('usage: host-history-pages-real.mjs <evidence-directory>');
fs.mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
  throw new Error('Commit the final task head before VM verification.');
const { buildBundle } = require('../electron/host/bundle.cjs');
const bundle = buildBundle({ root, outDir: path.join(out, 'bundle'), build: 'darwin-arm64' });
const m = createChannel({ launcher: vmLauncher(vm, path.join(root, 'scripts/vm-exec.sh')) });
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const temp = await m.run('mktemp -d /tmp/host-page-proof.XXXXXX');
if (temp.code !== 0) throw new Error(temp.stderr);
const remote = temp.stdout.trim();
if (!/^\/tmp\/host-page-proof\.[\w]+$/.test(remote)) throw new Error('Unexpected task directory.');
try {
  const unpack = await m.run(`tar -xz -f - -C ${quote(remote)}`, fs.readFileSync(bundle.file));
  if (unpack.code !== 0) throw new Error(unpack.stderr);
  const upload = await m.run(
    `mkdir -p ${quote(remote + '/bench')} && cat > ${quote(remote + '/bench/host-history-pages-guest.mjs')}`,
    fs.readFileSync(path.join(root, 'bench/host-history-pages-guest.mjs')),
  );
  if (upload.code !== 0) throw new Error(upload.stderr);
  const result = await m.run(`node ${quote(remote + '/bench/host-history-pages-guest.mjs')}`);
  fs.writeFileSync(
    path.join(out, 'evidence.json'),
    JSON.stringify({ head, vm, bundle: { buildId: bundle.buildId, sha256: bundle.sha256 }, result }, null, 2),
  );
  process.stdout.write(result.stdout + result.stderr);
  if (result.code !== 0 || JSON.parse(result.stdout.trim()).pass !== true)
    throw new Error('Real Host restart verification failed; see evidence.json.');
} finally {
  await m.run(`rm -rf ${quote(remote)}`);
}
