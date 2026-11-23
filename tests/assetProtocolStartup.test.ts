// The startup registration connects admitted local image/media requests to the asynchronous asset handler.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

test('ready: codex-asset serves admitted images/media asynchronously, with Windows drive paths', async () => {
  for (const platform of ['darwin', 'win32']) {
    const h = await loadMain({ platform });
    await h.ready();
    h.electron.net.fetch.mock.mockImplementation(async () => new Response('media', { status: 200 }));
    const [scheme, handler] = calls(h.electron.protocol.handle)[0];
    assert.equal(scheme, 'codex-asset');
    const r = await handler({ url: 'codex-asset:///etc/passwd' });
    assert.equal(r.status, 403);
    const image = await handler({ url: 'codex-asset:///tmp/a%20b.PNG' });
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(calls(h.electron.net.fetch).at(-1)[0], 'file:///tmp/a%20b.PNG');
    await handler({ url: 'codex-asset:///C:/dir/a.png' });
    // Windows drops the leading slash before the drive letter (a relative path on the macOS test machine)
    const got = calls(h.electron.net.fetch).at(-1)[0];
    assert.equal(got === 'file:///C:/dir/a.png', platform !== 'win32');
    assert.ok(got.endsWith('/C:/dir/a.png'));
    const video = await handler({ url: 'codex-asset:///tmp/movie.mp4', headers: new Headers({ Range: 'bytes=1-' }) });
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.equal(calls(h.electron.protocol.registerSchemesAsPrivileged)[0][0][0].privileges.stream, true);
  }
});
