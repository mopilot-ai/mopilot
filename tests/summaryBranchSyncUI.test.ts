// The Changes section's branch row, as Claude Desktop's (src/components/panels/SummaryBranchSync.tsx): "{branch} → {upstream}",
// commits to push and behind, and Push on the user's click (publishing a branch with no upstream), read from git alone.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { act, createElement as h } from 'react';
import './support/dom.ts';
import { tick } from './support/async-scenarios.ts';
import { fakeStore, one, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';
import { installNative } from '../src/lib/native.ts';
import { fakeNative } from './support/ports/native.ts';

const store = fakeStore({});
stubStore(store.exports);
const { SummaryBranchSync, readBranchSync, syncWords } = await import('../src/components/panels/SummaryBranchSync.tsx');

type Answer = { ok: boolean; code: number; stdout: string; stderr: string };
const ok = (stdout: string): Answer => ({ ok: true, code: 0, stdout, stderr: '' });
const no = (stderr = 'fatal'): Answer => ({ ok: false, code: 1, stdout: '', stderr });
let answers: Record<string, Answer | Promise<Answer>> = {};
const ran: string[] = [];
const toasts = () => store.calls.filter((c) => c[0] === 'toast').map((c) => c[1]);

beforeEach(() => {
  ran.length = 0;
  store.calls.length = 0;
  answers = {};
  installNative(
    fakeNative({
      git: {
        run: async (_cwd: string, args: string[]) => {
          const key = args.join(' ');
          ran.push(key);
          return answers[key] ?? no();
        },
      },
    }),
  );
});

const settle = async () => {
  await tick();
  await act(async () => {});
};
const row = (host: HTMLElement) => [one(host, '.summary-label').textContent, one(host, '.summary-hint').textContent];

test('a branch with commits to push says so, and Push sends them and reads again', async () => {
  answers = {
    'rev-parse --abbrev-ref HEAD': ok('feat/rail\n'),
    'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': ok('origin/feat/rail\n'),
    'rev-list --left-right --count @{upstream}...HEAD': ok('1\t3\n'),
  };
  const r = await render(h(SummaryBranchSync, { cwd: '/repo', version: 1 }));
  await settle();
  assert.deepEqual(row(r.host), ['feat/rail → origin/feat/rail', '3 commits to push · 1 behind']);
  answers['rev-list --left-right --count @{upstream}...HEAD'] = ok('0\t0\n');
  let pushed: (a: Answer) => void = () => {};
  answers.push = new Promise<Answer>((resolve) => (pushed = resolve));
  await act(() => (one(r.host, 'button', 'Push') as HTMLElement).click());
  assert.equal(one(r.host, '.summary-hint').textContent, 'Pushing…');
  assert.equal((one(r.host, 'button', 'Push') as HTMLButtonElement).disabled, true, 'a second click waits');
  pushed(ok(''));
  await settle();
  assert.ok(ran.includes('push'));
  assert.deepEqual(row(r.host), ['feat/rail → origin/feat/rail', 'Up to date']);
  assert.equal(r.host.querySelector('button'), null, 'nothing to push, no Push');
  await r.unmount();
});

test('a branch never pushed is published to origin; a refused push says why', async () => {
  answers = { 'rev-parse --abbrev-ref HEAD': ok('new-work\n'), 'push -u origin HEAD': no('remote: Permission denied\n') };
  const r = await render(h(SummaryBranchSync, { cwd: '/repo', version: 1 }));
  await settle();
  assert.deepEqual(row(r.host), ['new-work', 'Not pushed yet']);
  await act(() => (one(r.host, 'button', 'Push') as HTMLElement).click());
  await settle();
  assert.ok(ran.includes('push -u origin HEAD'));
  assert.deepEqual(toasts(), ["Couldn't push new-work: remote: Permission denied"]);
  answers['push -u origin HEAD'] = { ok: false, code: 128, stdout: '', stderr: '' };
  await act(() => (one(r.host, 'button', 'Push') as HTMLElement).click());
  await settle();
  assert.equal(toasts().at(-1), "Couldn't push new-work: git push exited with 128");
  await r.unmount();
});

test('a detached head, an unreadable count or a failed read shows no row, and the words cover each standing', async () => {
  answers = { 'rev-parse --abbrev-ref HEAD': ok('HEAD\n') };
  assert.equal(await readBranchSync('/repo'), null);
  answers = {};
  assert.equal(await readBranchSync('/repo'), null);
  answers = {
    'rev-parse --abbrev-ref HEAD': ok('main\n'),
    'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': ok('origin/main\n'),
  };
  assert.equal(await readBranchSync('/repo'), null, 'no count, no claim');
  answers['rev-list --left-right --count @{upstream}...HEAD'] = ok('x y\n');
  assert.equal(await readBranchSync('/repo'), null);
  assert.equal(syncWords({ branch: 'b', upstream: 'o/b', ahead: 1, behind: 0 }), '1 commit to push');
  assert.equal(syncWords({ branch: 'b', upstream: 'o/b', ahead: 0, behind: 2 }), '2 behind');
  installNative(fakeNative({ git: { run: async () => Promise.reject(new Error('git is gone')) } }));
  const r = await render(h(SummaryBranchSync, { cwd: '/repo', version: 1 }));
  await settle();
  assert.equal(r.host.textContent, '');
  // a reply for another folder is not this one's
  answers = { 'rev-parse --abbrev-ref HEAD': ok('main\n') };
  installNative(fakeNative({ git: { run: async (_c: string, a: string[]) => answers[a.join(' ')] ?? no() } }));
  await r.rerender(h(SummaryBranchSync, { cwd: '/other', version: 2 }));
  await settle();
  assert.deepEqual(row(r.host), ['main', 'Not pushed yet']);
  await r.unmount();
});
