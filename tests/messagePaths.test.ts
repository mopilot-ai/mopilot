// src/lib/messagePaths.ts: which inline code may be a path, and main's answer for it kept per chat folder for 30 s,
// asked again when the window is focused after that, with one request per path and the latest answer winning.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { render, settle, native, window } from './support/thread-kit.ts';

const { pathCandidate, useMessagePath, lookupMessagePath, resetMessagePaths, MESSAGE_PATH_TTL_MS, MESSAGE_PATH_MAX } = await import(
  '../src/lib/messagePaths.ts'
);

/** main's answers: what each path resolves to, and every request it got. */
let answers: Record<string, any> = {};
const asked: [string, string | null][] = [];
let pending: ((v: any) => void)[] = [];
let hold = false;
native.fs = {
  messagePath: (p: string, cwd: string | null) => {
    asked.push([p, cwd]);
    if (hold) return new Promise((r) => pending.push(r));
    const a = answers[p];
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? null);
  },
};
let now = 1_000_000;
mock.method(Date, 'now', () => now);
beforeEach(() => {
  resetMessagePaths();
  answers = {};
  asked.length = 0;
  pending = [];
  hold = false;
  now += 10 * MESSAGE_PATH_TTL_MS;
});

const seen: any[] = [];
function Probe({ path, cwd }: { path: string | null; cwd?: string | null }) {
  const found = useMessagePath(path, cwd);
  seen.push(found);
  return h('i', null, found ? `${found.kind}:${found.path}` : 'none');
}
const focus = () => settle(() => window.dispatchEvent(new window.Event('focus') as any));

test('inline code that may be a path: rooted, with a slash, or a bare file name; never URLs, flags or shell', () => {
  const cases: [string, ReturnType<typeof pathCandidate>][] = [
    ['~/Downloads/MoPilot_film_v2/', { path: '~/Downloads/MoPilot_film_v2/', line: undefined }],
    ['MoPilot_film_9x16.mp4', { path: 'MoPilot_film_9x16.mp4', line: undefined }],
    ['src/a.ts:12', { path: 'src/a.ts', line: 12 }],
    ['src/a.ts:12:5', { path: 'src/a.ts', line: 12 }],
    ['b/server/index.js#L10', { path: 'b/server/index.js', line: 10 }],
    ['main.rs#L3C2', { path: 'main.rs', line: 3 }],
    ['C:\\repo\\main.rs:12:5', { path: 'C:\\repo\\main.rs', line: 12 }],
    ['src/a.ts#L5-L20', { path: 'src/a.ts', line: 5, endLine: 20 }],
    ['src/a.ts#L5C2-L20C1', { path: 'src/a.ts', line: 5, endLine: 20 }],
    ['src/a.ts#L5-20', { path: 'src/a.ts', line: 5, endLine: 20 }],
    ['src/a.ts:5-20', { path: 'src/a.ts', line: 5, endLine: 20 }],
    ['src/a.ts#L20-L5', { path: 'src/a.ts', line: 20 }],
    ['src/a.ts:7-7', { path: 'src/a.ts', line: 7 }],
    ['/Users/me/My Project/notes.md', { path: '/Users/me/My Project/notes.md', line: undefined }],
    ['~', { path: '~', line: undefined }],
    ['src', null],
    ['npm run build', null],
    ['cd src/app', null],
    ['https://example.com/a.md', null],
    ['--help', null],
    ['ls *.ts', null],
    ['echo $HOME/x', null],
    ['a\nb/c', null],
    [':12', null],
    ['', null],
    ['x/'.repeat(600), null],
  ];
  for (const [text, want] of cases) assert.deepEqual(pathCandidate(text), want, text);
});

test('one request per path and folder: a second link reuses the answer, another folder asks again', async () => {
  answers['src/a.ts'] = { path: '/repo/src/a.ts', kind: 'file' };
  const v = await render(h('div', null, h(Probe, { path: 'src/a.ts', cwd: '/repo' }), h(Probe, { path: 'src/a.ts', cwd: '/repo' })));
  await settle();
  assert.deepEqual(
    v.$$('i').map((n) => n.textContent),
    ['file:/repo/src/a.ts', 'file:/repo/src/a.ts'],
  );
  assert.deepEqual(asked, [['src/a.ts', '/repo']]);
  await v.rerender(h(Probe, { path: 'src/a.ts', cwd: '/other' }));
  await settle();
  assert.deepEqual(asked.at(-1), ['src/a.ts', '/other']);
  assert.equal(v.$('i')!.textContent, 'file:/repo/src/a.ts');
  await v.rerender(h(Probe, { path: null }));
  assert.equal(v.$('i')!.textContent, 'none');
  assert.equal(asked.length, 2, 'no path, no request');
  await v.unmount();
});

test('a focused window asks again only after the TTL; an unchanged answer keeps its object, a deleted file goes plain', async () => {
  answers['out/film.mp4'] = { path: '/repo/out/film.mp4', kind: 'file' };
  const v = await render(h(Probe, { path: 'out/film.mp4', cwd: '/repo' }));
  await settle();
  const first = seen.at(-1);
  await focus();
  assert.equal(asked.length, 1, 'still fresh');
  now += MESSAGE_PATH_TTL_MS;
  answers['out/film.mp4'] = { path: '/repo/out/film.mp4', kind: 'file' };
  await focus();
  assert.equal(asked.length, 2);
  assert.equal(seen.at(-1), first, 'the same answer is the same object');
  now += MESSAGE_PATH_TTL_MS;
  delete answers['out/film.mp4'];
  await focus();
  assert.equal(v.$('i')!.textContent, 'none');
  await v.unmount();
  now += MESSAGE_PATH_TTL_MS;
  await focus();
  assert.equal(asked.length, 3, 'an unmounted link stops listening');
});

test('a failed refresh keeps the last answer: a shown link stays a link', async () => {
  answers['src/a.ts'] = { path: '/repo/src/a.ts', kind: 'file' };
  const v = await render(h(Probe, { path: 'src/a.ts', cwd: '/repo' }));
  await settle();
  now += MESSAGE_PATH_TTL_MS;
  answers['src/a.ts'] = new Error('bridge down');
  await focus();
  assert.equal(asked.length, 2);
  assert.equal(v.$('i')!.textContent, 'file:/repo/src/a.ts');
  await v.unmount();
});

test('a failed request reads as nothing there; a pending one is not asked twice', async () => {
  answers['a/b.ts'] = new Error('bridge down');
  const v = await render(h(Probe, { path: 'a/b.ts', cwd: '/r' }));
  await settle();
  assert.equal(v.$('i')!.textContent, 'none');
  await v.unmount();
  hold = true;
  now += MESSAGE_PATH_TTL_MS;
  const w = await render(h('div', null, h(Probe, { path: 'a/b.ts', cwd: '/r' }), h(Probe, { path: 'c/d.ts', cwd: '/r' })));
  await focus();
  assert.deepEqual(
    asked.map(([p]) => p),
    ['a/b.ts', 'a/b.ts', 'c/d.ts'],
  );
  await settle(() => pending.forEach((r) => r({ path: '/r/x', kind: 'dir' })));
  assert.deepEqual(
    w.$$('i').map((n) => n.textContent),
    ['dir:/r/x', 'dir:/r/x'],
  );
  await w.unmount();
});

test("a click's fresh lookup wins over an older one that answers later, and updates every link", async () => {
  hold = true;
  const v = await render(h(Probe, { path: 'src/a.ts', cwd: '/repo' }));
  const slow = pending.shift()!;
  hold = false;
  answers['src/a.ts'] = null;
  assert.equal(await lookupMessagePath('src/a.ts', '/repo'), null);
  await settle(() => slow({ path: '/repo/src/a.ts', kind: 'file' }));
  assert.equal(v.$('i')!.textContent, 'none', 'the older answer is dropped');
  answers['src/a.ts'] = { path: '/repo/src/a.ts', kind: 'file' };
  await settle(() => lookupMessagePath('src/a.ts', '/repo'));
  assert.equal(v.$('i')!.textContent, 'file:/repo/src/a.ts');
  await v.unmount();
});

test('at most MESSAGE_PATH_MAX answers are kept: the oldest is asked again', async () => {
  for (let i = 0; i <= MESSAGE_PATH_MAX; i++) await lookupMessagePath(`f${i}.md`);
  asked.length = 0;
  const v = await render(h('div', null, h(Probe, { path: 'f0.md' }), h(Probe, { path: `f${MESSAGE_PATH_MAX}.md` })));
  await settle();
  assert.deepEqual(asked, [['f0.md', null]]);
  await v.unmount();
});
