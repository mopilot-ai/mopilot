// Rebuilds Linux node-pty against Electron, pruning build sources only for a staged package.
import { rebuild } from '@electron/rebuild';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/** @param {{ buildPath: string, arch: string, prune?: boolean, rebuildFn?: (options: Parameters<typeof rebuild>[0]) => Promise<unknown> }} o */
export async function rebuildLinuxPty({ buildPath, arch, prune = true, rebuildFn = rebuild }) {
  const electronVersion = JSON.parse(readFileSync(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8')).version;
  await rebuildFn({ buildPath, electronVersion, arch, onlyModules: ['node-pty'], force: true });
  const dir = path.join(buildPath, 'node_modules/node-pty');
  if (!existsSync(path.join(dir, 'build/Release/pty.node'))) throw new Error('The Linux terminal build is missing pty.node');
  if (!prune) return;
  for (const file of ['src', 'deps', 'third_party', 'scripts', 'binding.gyp', 'build/Release/obj.target'])
    rmSync(path.join(dir, file), { recursive: true, force: true });
}
