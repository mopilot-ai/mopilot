// Repository identity used for sidebar placement, independent of a session's execution location.
import { publicRemote } from './host/codeTransfer.mjs';

/** @param {URL} url */
const urlParts = (url) => [url.host, url.pathname];

/** @param {unknown} remote */
export function sidebarRepository(remote) {
  const safe = publicRemote(remote);
  if (!safe) return null;
  const scp = /^git@([\w.-]+):(.+)$/.exec(safe);
  const [domain, checkout] = scp ? [scp[1], scp[2]] : urlParts(new URL(safe));
  const host = domain.toLowerCase();
  const path = checkout.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!path || /[?#\\\s]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return `${host}/${host === 'github.com' ? path.toLowerCase() : path}`;
}

/** @param {unknown} name */
export function cloudRepository(name) {
  return typeof name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(name) ? sidebarRepository(`https://github.com/${name}`) : null;
}

/**
 * Return a safe origin, null for a determined absence, or undefined when Git could not answer.
 * @param {(args: string[]) => Promise<{ok: boolean, stdout: string, stderr: string}>} run
 */
export async function readSidebarOrigin(run) {
  const repository = await run(['rev-parse', '--is-inside-work-tree']);
  if (!repository.ok) return /not a git repository/i.test(repository.stderr) ? null : undefined;
  if (repository.stdout.trim() !== 'true') return null;
  const origin = await run(['remote', 'get-url', 'origin']);
  if (!origin.ok) return /no such remote/i.test(origin.stderr) ? null : undefined;
  return publicRemote(origin.stdout);
}

/** @param {{repo?: unknown, repositories?: unknown}} env */
export function environmentRepository(env) {
  const repositories = env.repositories ?? [env.repo];
  return Array.isArray(repositories) && repositories.length === 1 ? cloudRepository(repositories[0]) : null;
}
