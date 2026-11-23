// The Host specs' fake `ssh` (fake-ssh/ssh) and the fake Hosts beside it, and the folder that puts that `ssh` first on PATH on each platform.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeCommand } from './nodeCommand';

/** fixtures/fake-ssh: the fake `ssh` script and the resident fake Hosts (host-chats.cjs, host-wire.mjs). */
export const FAKE_SSH = path.join(__dirname, 'fake-ssh');

/**
 * The folder a spec puts first on PATH (and the login shell's) so the app's `ssh` is the fake: fake-ssh itself on macOS
 * and Linux, where its script runs as it is, and on Windows a folder of its own holding a launcher ssh.exe that runs it,
 * since the app finds only a program there.
 */
export const FAKE_SSH_BIN = process.platform === 'win32' ? windowsSshBin() : FAKE_SSH;

/** The launcher folder of this process, removed when the process ends. */
function windowsSshBin(): string {
  const dir = path.dirname(nodeCommand(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-bin-')), 'ssh', path.join(FAKE_SSH, 'ssh')));
  process.once('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a launcher still running holds its .exe: the temp folder is the runner's to clear
    }
  });
  return dir;
}

/**
 * Why a Host spec whose fake machine is this one skips Windows: the fake `ssh` serves this runner's own folders and builds
 * as the machine's, and a Host is a Linux or macOS machine (docs/host.md) whose folders are POSIX paths, which the app
 * holds a Host to (shared/remote/schema.mjs folderOf); a Windows runner can't stand in for one.
 */
export const NO_HOST_HERE =
  "the fake Host serves this runner's own folders and build as the machine's, and a Host is a Linux or macOS machine with POSIX paths (docs/host.md)";
