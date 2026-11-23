import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { remoteCwd } from '../src/lib/remotePaths.ts';

const calls: unknown[][] = [];
(globalThis as any).__openCalls = calls;
const stub = (source: string) => ({ url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true });
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/src/session/open.ts')) {
      if (specifier === '../lib/paths' || specifier === '../lib/platform') return next(specifier + '.ts', context);
      if (specifier === '../lib/native')
        return stub(
          'export const native = { mopilot: { openWeb: p => (globalThis.__openCalls.push(["mopilot", p]), globalThis.__externalAnswer ?? Promise.resolve()) }, shell: { openExternal: u => (globalThis.__openCalls.push(["external", u]), globalThis.__externalAnswer ?? Promise.resolve()), reveal: p => (globalThis.__openCalls.push(["reveal", p]), globalThis.__revealAnswer ?? Promise.resolve()), openPath: p => (globalThis.__openCalls.push(["finder", p]), globalThis.__openAnswer), openIn: (d, p) => (globalThis.__openCalls.push([d, p]), globalThis.__openAnswer) } };',
        );
      // main's answer (electron/platform/messagePath.cjs) as a fake: "~" is /home/u, a relative path joins cwd,
      // a trailing slash is a folder, and a path in globalThis.__gone (or rejected by __lookupFails) is not there
      if (specifier === '../lib/messagePaths')
        return stub(
          'export const lookupMessagePath = async (p, cwd) => { if (globalThis.__lookupFails) throw new Error("bridge down"); const abs = /^~(?=$|[\\\\/])/.test(p) ? "/home/u" + p.slice(1) : /^(\\/|[A-Za-z]:[\\\\/])/.test(p) ? p : cwd ? cwd + "/" + p : null; if (!abs || (globalThis.__gone ?? []).includes(abs)) return null; return /[\\\\/]$/.test(abs) ? { path: abs.replace(/[\\\\/]+$/, ""), kind: "dir" } : { path: abs, kind: "file" }; };',
        );
      if (specifier === '../store/core')
        return stub(
          'export const useStore = { getState: () => ({ prefs: { openDestination: globalThis.__openDest ?? "finder", localUrlDestination: "default" } }) }; export const toast = (...a) => globalThis.__openCalls.push(["toast", ...a]); export const toastFailure = (what) => (e) => globalThis.__openCalls.push(["toast", `${what}: ${e.message}`, "error"]);',
        );
      if (specifier === '../store/panes')
        return stub('export const openPaneTab = (kind, tab) => globalThis.__openCalls.push([kind, tab]);');
    }
    return next(specifier, context);
  },
});
const { openUrl, openPath, openMessageLink, openMessagePath, showInFinder, openInApp, openFile, revealPath, openLink, openMoPilotPage } =
  await import('../src/session/open.ts');
/** A local message path is looked up in main before it opens. */
const tick = () => new Promise((r) => setTimeout(r, 0));

test('ordinary links open an in-app tab, including local sites and uppercase protocols', () => {
  for (const url of [
    'https://example.com/path?q=1#section',
    'http://localhost:3000',
    'http://127.0.0.1:8080',
    'http://[::1]:8000',
    'HTTPS://EXAMPLE.COM',
  ]) {
    calls.length = 0;
    openUrl(url);
    assert.deepEqual(calls, [['browser', { url, title: url }]]);
  }
});

test('an explicit external click bypasses the in-app tab for remote and local links', () => {
  for (const url of ['https://example.com', 'http://localhost:3000']) {
    calls.length = 0;
    openUrl(url, true);
    assert.deepEqual(calls, [['external', url]]);
  }
});

test('mail links retain their system handler', () => {
  calls.length = 0;
  openUrl('mailto:dev@example.com');
  assert.deepEqual(calls, [['external', 'mailto:dev@example.com']]);
});

test("a MoPilot web page opens in the system browser, and one that doesn't open says why", async () => {
  calls.length = 0;
  openMoPilotPage('/credits');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.splice(0), [['mopilot', '/credits']]);
  (globalThis as any).__externalAnswer = Promise.reject(new Error('no default browser'));
  try {
    openMoPilotPage('/account');
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    delete (globalThis as any).__externalAnswer;
  }
  assert.deepEqual(calls, [
    ['mopilot', '/account'],
    ['toast', "Couldn't open the MoPilot page: no default browser", 'error'],
  ]);
});

test('a link sent to the system browser that does not open says why (a Cmd-click on a message link)', async () => {
  calls.length = 0;
  (globalThis as any).__externalAnswer = Promise.reject(new Error('no default browser'));
  try {
    openMessageLink('https://example.com/a', undefined, { metaKey: true, ctrlKey: false });
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    delete (globalThis as any).__externalAnswer;
  }
  assert.deepEqual(calls, [
    ['external', 'https://example.com/a'],
    ['toast', "Couldn't open the link: no default browser", 'error'],
  ]);
});

test('local files still follow the file destination preference', () => {
  calls.length = 0;
  openPath('/repo/src/main.ts');
  assert.deepEqual(calls, [['finder', '/repo/src/main.ts']]);
});

test('ordinary message file links open a right-pane preview instead of a native app', async () => {
  calls.length = 0;
  openMessageLink('/tmp/investigation/result.json');
  await tick();
  assert.deepEqual(calls, [
    ['file', { path: '/tmp/investigation/result.json', line: undefined, endLine: undefined, cwd: undefined, title: 'result.json' }],
  ]);
});

test('relative message files resolve against their conversation folder', async () => {
  calls.length = 0;
  openMessageLink('src/main.ts', '/repo');
  await tick();
  assert.deepEqual(calls, [['file', { path: '/repo/src/main.ts', line: undefined, endLine: undefined, cwd: '/repo', title: 'main.ts' }]]);
});

test('file citations preserve the target line without passing it to the filesystem', async () => {
  for (const [href, endLine] of [
    ['/repo/main.ts:12', undefined],
    ['/repo/main.ts#L12', undefined],
    ['/repo/main.ts:12:8', undefined],
    ['/repo/main.ts#L12C3', undefined],
    ['/repo/main.ts#L12-20', 20],
    ['/repo/main.ts:12-20', 20],
    ['/repo/main.ts#L12C1-L20C4', 20],
    ['/repo/main.ts#L12-L12', undefined],
    ['/repo/main.ts#L12-L3', undefined],
  ] as const) {
    calls.length = 0;
    openMessageLink(href, '/repo');
    await tick();
    assert.deepEqual(calls, [['file', { path: '/repo/main.ts', line: 12, endLine, cwd: '/repo', title: 'main.ts' }]], href);
  }
});

test('encoded file links and Windows file URLs resolve to readable paths', async () => {
  for (const [href, path, title] of [
    ['file:///tmp/My%20Report.md:4', '/tmp/My Report.md', 'My Report.md'],
    ['file:///C:/repo/My%20Report.md:4', 'C:/repo/My Report.md', 'My Report.md'],
    ['C:\\repo\\main.ts:4', 'C:\\repo\\main.ts', 'main.ts'],
  ]) {
    calls.length = 0;
    openMessageLink(href);
    await tick();
    assert.deepEqual(calls, [['file', { path, line: 4, endLine: undefined, cwd: undefined, title }]]);
  }
});

test('literal percent signs in filenames do not prevent preview', async () => {
  calls.length = 0;
  openMessageLink('/tmp/build%log.txt');
  await tick();
  assert.deepEqual(calls, [
    ['file', { path: '/tmp/build%log.txt', line: undefined, endLine: undefined, cwd: undefined, title: 'build%log.txt' }],
  ]);
});

test('Command-click opens the resolved file externally with no preview tab', async () => {
  calls.length = 0;
  openMessageLink('src/main.ts:12', '/repo', { metaKey: true, ctrlKey: false });
  await tick();
  assert.deepEqual(calls, [['finder', '/repo/src/main.ts']]);
});

test('Control-click on macOS does not request an external app', async () => {
  calls.length = 0;
  openMessageLink('/repo/main.ts', undefined, { metaKey: false, ctrlKey: true });
  await tick();
  assert.equal(calls[0][0], 'file');
});

test('message web links use the existing browser routing and preserve URL fragments', () => {
  const url = 'https://example.com/path?q=1#section';
  calls.length = 0;
  openMessageLink(url);
  assert.deepEqual(calls, [['browser', { url, title: url }]]);
  calls.length = 0;
  openMessageLink(url, undefined, { metaKey: true, ctrlKey: false });
  assert.deepEqual(calls, [['external', url]]);
});

test('message mail links use their system handler instead of being treated as files', () => {
  calls.length = 0;
  openMessageLink('mailto:dev@example.com');
  assert.deepEqual(calls, [['external', 'mailto:dev@example.com']]);
});

test('files open in the chosen editor when the destination is not Finder', () => {
  calls.length = 0;
  (globalThis as any).__openDest = 'vscode';
  try {
    openPath('/repo/a.ts');
  } finally {
    delete (globalThis as any).__openDest;
  }
  assert.deepEqual(calls, [['vscode', '/repo/a.ts']]);
});

test('encoded reserved filename characters decode without becoming line citations', async () => {
  for (const [href, path, line] of [
    ['file:///tmp/hash%23name.txt:4', '/tmp/hash#name.txt', 4],
    ['file:///tmp/query%3Fname.txt', '/tmp/query?name.txt', undefined],
    ['file:///tmp/file%3A12', '/tmp/file:12', undefined],
    ['file:///tmp/file%23L12', '/tmp/file#L12', undefined],
    ['file:///tmp/percent%2520.txt', '/tmp/percent%20.txt', undefined],
  ] as const) {
    calls.length = 0;
    openMessageLink(href);
    await tick();
    assert.deepEqual(calls, [['file', { path, line, endLine: undefined, cwd: undefined, title: path.slice(path.lastIndexOf('/') + 1) }]]);
  }
});

test('file URL hosts preserve absolute local and network locations', async () => {
  for (const [href, path] of [
    ['file://localhost/tmp/report.txt:7', '/tmp/report.txt'],
    ['FILE://LOCALHOST/C:/repo/report.txt:7', 'C:/repo/report.txt'],
    ['file://server/share/My%20Report.txt:7', '//server/share/My Report.txt'],
    ['file://C:/repo/report.txt:7', 'C:/repo/report.txt'],
  ]) {
    calls.length = 0;
    openMessageLink(href, '/chat-folder');
    await tick();
    assert.deepEqual(calls, [
      ['file', { path, line: 7, endLine: undefined, cwd: '/chat-folder', title: path.slice(path.lastIndexOf('/') + 1) }],
    ]);
  }
  calls.length = 0;
  openMessageLink('file://server/share/report.txt', '/chat-folder', { metaKey: true, ctrlKey: false });
  await tick();
  assert.deepEqual(calls, [['finder', '//server/share/report.txt']]);
});

test('file URI single-slash forms and L-prefixed line ranges resolve to their file', async () => {
  for (const [href, path, line, endLine] of [
    ['file:/tmp/report.txt:8', '/tmp/report.txt', 8, undefined],
    ['file:/C:/repo/report.txt:8', 'C:/repo/report.txt', 8, undefined],
    ['/tmp/report.txt#L12-L20', '/tmp/report.txt', 12, 20],
    ['file:///tmp/My%20Report.txt#L12-L20', '/tmp/My Report.txt', 12, 20],
  ] as const) {
    calls.length = 0;
    openMessageLink(href, '/chat-folder');
    await tick();
    assert.deepEqual(calls, [['file', { path, line, endLine, cwd: '/chat-folder', title: path.slice(path.lastIndexOf('/') + 1) }]]);
  }
});

test("a file or folder that doesn't open says why, in Finder or in the chosen app", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const failures = () => calls.filter((c) => c[0] === 'toast');
  try {
    // shell.openPath answers an error text ('' when it opened)
    (globalThis as any).__openAnswer = Promise.resolve('');
    showInFinder('/repo');
    await settle();
    assert.deepEqual(failures(), []);
    (globalThis as any).__openAnswer = Promise.resolve('Failed to open path');
    showInFinder('/repo/gone');
    await settle();
    assert.deepEqual(failures().at(-1), ['toast', "Couldn't open gone: Failed to open path", 'error']);
    // an app launch answers { ok: false, stderr }, or { ok: false } with nothing said
    (globalThis as any).__openDest = 'vscode';
    (globalThis as any).__openAnswer = Promise.resolve({ ok: true, stderr: '' });
    openPath('/repo/a.ts');
    await settle();
    assert.equal(failures().length, 1);
    (globalThis as any).__openAnswer = Promise.resolve({ ok: false, stderr: 'Unable to find application named Visual Studio Code' });
    openPath('/repo/a.ts');
    await settle();
    assert.deepEqual(failures().at(-1), ['toast', "Couldn't open a.ts: Unable to find application named Visual Studio Code", 'error']);
    (globalThis as any).__openAnswer = Promise.resolve({ ok: false });
    openInApp('terminal', '/');
    await settle();
    assert.deepEqual(failures().at(-1), ['toast', "Couldn't open /: the app didn't start", 'error']);
    (globalThis as any).__openAnswer = Promise.resolve(null);
    openPath('/repo/a.ts');
    await settle();
    assert.equal(failures().length, 3);
    // the request itself can fail
    (globalThis as any).__openAnswer = Promise.reject(new Error('IPC closed'));
    openPath('/repo/a.ts');
    await settle();
    assert.deepEqual(failures().at(-1), ['toast', "Couldn't open a.ts: IPC closed", 'error']);
  } finally {
    delete (globalThis as any).__openDest;
    delete (globalThis as any).__openAnswer;
  }
});

test('opening a file in its default app, revealing it, and opening a link each say why when they fail', async () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  calls.length = 0;
  try {
    (globalThis as any).__openAnswer = Promise.resolve('');
    openFile('/repo/config.toml');
    revealPath('/repo/a b.ts');
    openLink('https://example.com/docs');
    await settle();
    assert.deepEqual(calls.splice(0), [
      ['finder', '/repo/config.toml'],
      ['reveal', '/repo/a b.ts'],
      ['external', 'https://example.com/docs'],
    ]);
    (globalThis as any).__openAnswer = Promise.resolve('No application knows how to open it');
    (globalThis as any).__revealAnswer = Promise.reject(new Error('reveal failed'));
    (globalThis as any).__externalAnswer = Promise.reject(new Error('no browser'));
    openFile('/repo/config.toml');
    revealPath('/repo/a b.ts');
    openLink('https://example.com/docs');
    await settle();
    assert.deepEqual(
      calls.filter((c) => c[0] === 'toast'),
      [
        ['toast', "Couldn't open config.toml: No application knows how to open it", 'error'],
        ['toast', "Couldn't show a b.ts: reveal failed", 'error'],
        ['toast', "Couldn't open the link: no browser", 'error'],
      ],
    );
  } finally {
    delete (globalThis as any).__openAnswer;
    delete (globalThis as any).__revealAnswer;
    delete (globalThis as any).__externalAnswer;
  }
});

test('file URL query and section fragments are metadata rather than filename characters', async () => {
  for (const [href, path, line] of [
    ['file:///repo/README.md#installation', '/repo/README.md', undefined],
    ['file:///repo/README.md#section:12', '/repo/README.md', undefined],
    ['file:///repo/README.md#section#L12', '/repo/README.md', undefined],
    ['file:///repo/main.ts?raw=1#L12', '/repo/main.ts', 12],
    ['file:///repo/main.ts:12?raw=1', '/repo/main.ts', 12],
    ['file://server/share/report.md?view=source#notes', '//server/share/report.md', undefined],
    ['file:///C:/repo/README.md#intro', 'C:/repo/README.md', undefined],
    ['file:///repo/hash%23notes%3F.txt?raw=1#details', '/repo/hash#notes?.txt', undefined],
  ] as const) {
    calls.length = 0;
    openMessageLink(href, '/chat-folder');
    await tick();
    assert.deepEqual(calls, [
      ['file', { path, line, endLine: undefined, cwd: '/chat-folder', title: path.slice(path.lastIndexOf('/') + 1) }],
    ]);
  }
  // Message paths coming from a tool are filenames, not URLs, and keep literal reserved characters.
  calls.length = 0;
  openMessageLink('/repo/hash#notes?.txt');
  await tick();
  assert.equal((calls[0][1] as any).path, '/repo/hash#notes?.txt');
});

test('Markdown URI mode separates relative link metadata while tool paths stay literal', async () => {
  for (const [href, path, line] of [
    ['README.md#installation', '/repo/README.md', undefined],
    ['src/main.ts?raw=1#L9', '/repo/src/main.ts', 9],
    ['hash%23name%3F.txt?raw=1#details', '/repo/hash#name?.txt', undefined],
  ] as const) {
    calls.length = 0;
    openMessageLink(href, '/repo', undefined, true);
    await tick();
    assert.deepEqual(calls, [['file', { path, line, endLine: undefined, cwd: '/repo', title: path.slice(path.lastIndexOf('/') + 1) }]]);
  }
});

test('Markdown file links preserve the literal folder of the remote worktree', async () => {
  const tree = '/srv/Team repo/app.worktrees/mopilot%2f03a201f8';
  const uri = '/srv/Team%20repo/app.worktrees/mopilot%2f03a201f8';
  const cwd = remoteCwd('ssh:box', `${tree}/packages/app`);
  for (const [href, path, line, endLine] of [
    [`${uri}/docs/host.md:106`, `${tree}/docs/host.md`, 106, undefined],
    [`${uri.replace('/Team', '//./Team')}/docs/host.md`, `${tree}/docs/host.md`, undefined, undefined],
    [`${uri}/a%20%23notes.md?raw=1#L7-L9`, `${tree}/a #notes.md`, 7, 9],
    [`${uri}/bad%escape.md`, `${tree}/bad%escape.md`, undefined, undefined],
    [`${uri.replace('%2f', '%252f')}/a.md`, `${tree}/a.md`, undefined, undefined],
    [`file://${uri.replace('%2f', '%252f')}/a.md`, `${tree}/a.md`, undefined, undefined],
    [`${uri}-other/a.md`, `${tree.replace('%2f', '/')}-other/a.md`, undefined, undefined],
    ['report%20final.md', `${tree}/packages/app/report final.md`, undefined, undefined],
  ] as const) {
    calls.length = 0;
    openMessageLink(href, cwd, undefined, true);
    await tick();
    assert.deepEqual(calls, [['file', { path, line, endLine, cwd, title: path.slice(path.lastIndexOf('/') + 1) }]], href);
  }
});

test('Windows Markdown file links preserve the literal folder of the chat', async () => {
  calls.length = 0;
  const cwd = 'C:\\Team repo\\branch%2fwork';
  openMessageLink('c:/team%20repo/branch%2Fwork/report%20final.md', cwd, undefined, true);
  await tick();
  assert.deepEqual(calls, [
    ['file', { path: 'c:/team repo/branch%2Fwork/report final.md', line: undefined, endLine: undefined, cwd, title: 'report final.md' }],
  ]);
});

test('the known worktree resolves an ambiguous bare path and an explicit file URL keeps its URI meaning', async () => {
  const cwd = remoteCwd('ssh:box', '/srv/app.worktrees/feature%252fx');
  calls.length = 0;
  openMessageLink('/srv/app.worktrees/feature%252fx/report.md', cwd, undefined, true);
  openMessageLink('file:///srv/app.worktrees/feature%252fx/report.md', cwd, undefined, true);
  await tick();
  assert.deepEqual(
    calls.map(([, target]) => (target as { path: string }).path),
    ['/srv/app.worktrees/feature%252fx/report.md', '/srv/app.worktrees/feature%2fx/report.md'],
  );
});

test('literal tool filename percent sequences are decoded only in URI mode', async () => {
  calls.length = 0;
  openMessageLink('/repo/100%20done%23notes.txt');
  await tick();
  assert.equal((calls[0][1] as any).path, '/repo/100%20done%23notes.txt');
  calls.length = 0;
  openMessageLink('/repo/100%20done%23notes.txt', undefined, undefined, true);
  await tick();
  assert.equal((calls[0][1] as any).path, '/repo/100 done#notes.txt');
});

test('a message path is looked up at the click: "~" is home, a folder opens in Finder (a Cmd-click too)', async () => {
  calls.length = 0;
  await openMessagePath('~/Downloads/film/', '/repo');
  await openMessagePath('~/Downloads/film/', '/repo', undefined, true);
  await openMessagePath('~/notes.md', null, { line: 3 });
  assert.deepEqual(calls, [
    ['finder', '/home/u/Downloads/film'],
    ['finder', '/home/u/Downloads/film'],
    ['file', { path: '/home/u/notes.md', line: 3, endLine: undefined, cwd: undefined, title: 'notes.md' }],
  ]);
});

test('a message path that is gone by the click, or one main cannot look up, is a toast and opens nothing', async () => {
  calls.length = 0;
  (globalThis as any).__gone = ['/repo/out/film.mp4'];
  try {
    openMessageLink('out/film.mp4', '/repo');
    await tick();
    await openMessagePath('src/a.ts', null);
  } finally {
    delete (globalThis as any).__gone;
  }
  (globalThis as any).__lookupFails = true;
  try {
    await openMessagePath('/repo/a.ts', '/repo');
  } finally {
    delete (globalThis as any).__lookupFails;
  }
  assert.deepEqual(calls, [
    ['toast', "Couldn't find film.mp4", 'error'],
    ['toast', "Couldn't find a.ts", 'error'],
    ['toast', "Couldn't open a.ts: bridge down", 'error'],
  ]);
});
