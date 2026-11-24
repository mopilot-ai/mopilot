// A page is handed a local file only through the folders the Host shares and never one of its own, and is made to fetch a web address only (host/src/browserLocalFiles.mjs, R2b of #5576): the upload command, a drag's files, a resource to load and a paused request's address are held to those rules by real path and by parsed protocol.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore
import { fetchesNonWeb, isWebAddress, localPathsOf, withLocalFileGate } from '../host/src/browserLocalFiles.mjs';
import { world, tab, code } from './support/browser-service-kit.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-files-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, 'home');
const data = path.join(home, 'data');
const work = path.join(home, 'work');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(data, 'host.sock.token'), 'SECRET');
fs.writeFileSync(path.join(work, 'photo.png'), 'png');
fs.symlinkSync(path.join(data, 'host.sock.token'), path.join(work, 'innocent.txt'));
const hostFs = createHostFs({ roots: [home], denied: [data] });

/** A service with the rule in front, and a tab of chat `c`. */
async function gated(withFolders = true) {
  const w = world();
  const host = withLocalFileGate(w.host, withFolders ? hostFs : undefined);
  const targetId = await tab(w);
  const command = (method: string, params: object) => host.command('c', { targetId, method, params });
  return { w, command };
}

test("an upload of a file in a shared folder goes through; the Host's own file, by name, link or .., never does", async () => {
  const ok = await gated();
  await ok.command('DOM.setFileInputFiles', { files: [path.join(work, 'photo.png')], objectId: 'n' });
  assert.equal(ok.w.chromium.sent('DOM.setFileInputFiles').length, 1);
  for (const file of [
    path.join(data, 'host.sock.token'),
    path.join(work, 'innocent.txt'),
    path.join(work, '..', 'data', 'host.sock.token'),
    path.join(data, 'missing'),
    path.join(base, 'outside.txt'),
    'relative/photo.png',
    '',
  ]) {
    const v = await gated();
    await assert.rejects(
      v.command('DOM.setFileInputFiles', { files: [path.join(work, 'photo.png'), file], objectId: 'n' }),
      code('refused'),
      file,
    );
    assert.equal(v.w.chromium.sent('DOM.setFileInputFiles').length, 0, `nothing of ${file} reached the browser`);
  }
});

test("a drag's files are held the same way, and a malformed list is refused", async () => {
  const g = await gated();
  const drag = (files: unknown) => g.command('Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [], files } });
  await drag([path.join(work, 'photo.png')]);
  await assert.rejects(drag([path.join(data, 'host.sock.token')]), code('refused'));
  await assert.rejects(drag(path.join(data, 'host.sock.token')), code('refused'), 'a single string is a list of one');
  await assert.rejects(drag([7]), code('invalid'));
});

test('an address a page is made to fetch is a web one by its PARSED protocol: file: in any spelling, data:, blob:, javascript: and what does not parse are refused', async () => {
  const g = await gated();
  const spellings = [
    'file:///etc/passwd',
    '  FILE:///x',
    'fi\tle:///x',
    '\u0001file:///x',
    'file\n:///x',
    '\u0000\u001f file:///x',
    'data:text/plain,x',
    'blob:https://a.test/1',
    'javascript:1',
    'chrome://version',
    'not a url',
    '',
    '/relative',
  ];
  for (const url of spellings) {
    await assert.rejects(g.command('Network.loadNetworkResource', { url, options: {} }), code('refused'), JSON.stringify(url));
    await assert.rejects(g.command('Fetch.continueRequest', { requestId: 'r', url }), code('refused'), `continue ${JSON.stringify(url)}`);
    await assert.rejects(
      g.command('Fetch.fulfillRequest', { requestId: 'r', responseCode: 200, url }),
      code('refused'),
      `fulfill ${JSON.stringify(url)}`,
    );
  }
  await assert.rejects(g.command('Network.loadNetworkResource', { options: {} }), code('refused'), 'a resource with no address');
  await assert.rejects(g.command('Fetch.continueRequest', { requestId: 'r', url: 7 }), code('refused'));
  // a web address, and a paused request left as it is, go through
  await g.command('Network.loadNetworkResource', { url: 'https://example.invalid/x', options: {} });
  await g.command('Network.loadNetworkResource', { url: ' HTTP://example.invalid/x', options: {} });
  await g.command('Fetch.continueRequest', { requestId: 'r' });
  await g.command('Fetch.continueRequest', { requestId: 'r', url: 'http://example.invalid/y' });
  await g.command('Fetch.fulfillRequest', { requestId: 'r', responseCode: 200 });
  assert.equal(g.w.chromium.sent('Network.loadNetworkResource').length, 2);
});

test("without the Host's folders to ask, no local file is handed to a page; an empty list (clearing the input) still goes", async () => {
  const g = await gated(false);
  await assert.rejects(g.command('DOM.setFileInputFiles', { files: [path.join(work, 'photo.png')] }), code('refused'));
  await g.command('DOM.setFileInputFiles', { files: [] });
  await g.command('DOM.setFileInputFiles', {});
});

test('which commands name a local file or an address', () => {
  assert.deepEqual(localPathsOf('DOM.setFileInputFiles', { files: ['/a', '/b'] }), ['/a', '/b']);
  assert.deepEqual(localPathsOf('DOM.setFileInputFiles', {}), []);
  assert.deepEqual(localPathsOf('DOM.setFileInputFiles', { files: '/a' }), ['/a']);
  assert.deepEqual(localPathsOf('Input.dispatchDragEvent', { data: { files: ['/a'] } }), ['/a']);
  assert.deepEqual(localPathsOf('Input.dispatchDragEvent', { data: {} }), []);
  assert.deepEqual(localPathsOf('Input.dispatchDragEvent', { data: { files: '/a' } }), ['/a']);
  assert.deepEqual(localPathsOf('Page.navigate', { url: 'https://x' }), []);
  assert.equal(isWebAddress('https://x.test'), true);
  assert.equal(isWebAddress('ftp://x.test'), false);
  assert.equal(isWebAddress(undefined), false);
  assert.equal(fetchesNonWeb('Page.navigate', { url: 'file:///x' }), false, 'a navigation has its own rule');
  assert.equal(fetchesNonWeb('toString', { url: 'file:///x' }), false, 'a name on a prototype is no command');
  assert.equal(fetchesNonWeb('Fetch.continueRequest', {}), false);
});
