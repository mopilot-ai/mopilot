// The way into the machine the run makes: a key pair of the run's own (never the provider key), and the ssh options that reach the Ubuntu user without touching the person's known hosts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sshLauncher } from '../channel.mjs';

/** The line `ssh-keygen` writes to the public key file for an ed25519 key. */
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [\w.-]+)?$/;

/**
 * Make a key pair in `dir` and read its public half. The private half stays in that folder, which the run removes.
 * @param {string} dir @param {typeof spawnSync} [run]
 */
export function makeKey(dir, run = spawnSync) {
  const keyFile = path.join(dir, 'id_ed25519');
  const made = run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'mopilot-accept', '-f', keyFile], { stdio: 'ignore' });
  if (made.status !== 0) throw new Error('ssh-keygen could not make the run’s key pair.');
  const pub = fs.readFileSync(`${keyFile}.pub`, 'utf8').trim();
  // the public key goes into a shell line on the machine: only the plain shape of one is accepted
  if (!PUBLIC_KEY.test(pub)) throw new Error('ssh-keygen wrote a public key of an unexpected shape.');
  return { keyFile, pub };
}

/** The ssh options for a machine made by this run. @param {string} keyFile */
export const sshOptions = (keyFile) => [
  '-i',
  keyFile,
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'LogLevel=ERROR',
  '-o',
  'ServerAliveInterval=15',
];

/** A channel launcher whose address is read at each call, so a machine that comes back on another address is still reached. @param {{ ip: string }} addr @param {string} keyFile */
export const launcherFor = (addr, keyFile) => (/** @type {string} */ command, /** @type {boolean} */ stdin) =>
  sshLauncher(`ubuntu@${addr.ip}`, sshOptions(keyFile))(command, stdin);
