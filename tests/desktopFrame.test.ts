// DesktopControl.frame (tools/desktopCapture.cjs): the small JPEG a paired phone's mirror shows, taken like the model's screenshot, of the granted apps only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES, MAIL, rig } from './support/desktop-kit.ts';

test('frame: only the granted apps, small, JPEG, on the chat’s chosen display, with no elements read and no session change', async () => {
  const r = rig();
  await r.grant([NOTES, MAIL]);
  r.helper.calls.length = 0;
  const frame = await r.d.frame('c1');
  assert.deepEqual(frame, { data: 'JPEG', width: 1000, height: 500 });
  assert.deepEqual(r.callsOf('screenshot')[0].args[0], {
    includeBundleIds: ['com.apple.Notes', 'com.apple.mail'],
    maxSide: 640,
    maxPixels: 640 * 640,
    format: 'jpeg',
    quality: 0.5,
  });
  assert.equal(r.callsOf('axSnapshot').length, 0, 'no elements are read for a frame');
  assert.equal(r.d.session('c1').geom, null, 'the model’s coordinate frame is not replaced by a frame');
  r.d.session('c1').display = 2;
  await r.d.frame('c1', 320);
  assert.equal(r.callsOf('screenshot')[1].args[0].display, 2);
  assert.equal(r.callsOf('screenshot')[1].args[0].maxSide, 320);
});

test('frame: nothing to show is null, a helper failure is the caller’s', async () => {
  const r = rig();
  assert.equal(await r.d.frame('c1'), null, 'no apps granted');
  await r.grant([NOTES]);
  r.helper.shot = () => ({ png: 'PNG', width: 1, height: 1, included: [] });
  assert.equal(await r.d.frame('c1'), null, 'an older helper answers with a png only');
  r.helper.fail.screenshot = Object.assign(new Error('no windows'), { reason: 'no_windows' });
  assert.equal(await r.d.frame('c1'), null, 'no window on screen');
  r.helper.fail.screenshot = new Error('helper stopped');
  await assert.rejects(() => r.d.frame('c1'), /helper stopped/);
});
