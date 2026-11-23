// Canonical root matching preserves nested-project precedence, home exclusions and explicit assignment identity.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store } = await loadStore();
const { projectForThread } = await import('../src/store/projects.ts');

test('canonical project lookup ranks physical roots, excludes aliased home and preserves explicit assignments', () => {
  store.useStore.setState({ home: '/home-alias' });
  const aliases: Record<string, string> = {
    '/home-alias': '/home/me',
    '/old/repo': '/work/repo',
    '/short-alias': '/work/repo/deep',
    '/old/repo/deep/chat': '/work/repo/deep/chat',
  };
  const resolve = (p: string) => aliases[p] ?? p;
  const projects = [
    { id: 'home', roots: [{ path: '/home/me' }] },
    { id: 'outer', roots: [{ path: '/old/repo' }] },
    { id: 'inner', roots: [{ path: '/short-alias' }] },
  ] as any;
  assert.equal(projectForThread({ cwd: '/old/repo/deep/chat' } as any, projects, resolve)!.id, 'inner');
  assert.equal(projectForThread({ cwd: '/home/me/chat' } as any, projects, resolve), null);
  assert.equal(projectForThread({ projectId: 'outer', cwd: '/old/repo/deep/chat' } as any, projects, resolve)!.id, 'outer');
});
