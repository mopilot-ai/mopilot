// desktop_app_click, type, key and scroll with `screenshot: true` (#3810): the window as it is after the action comes back in the same result, so a model that wants to see the effect needs no second call; without it nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECS, helperFailure, rig } from './support/app-scoped-kit.ts';

const click = { app: 'Notes', coordinate: [130, 70] };

test('the four input tools list the screenshot flag; the others do not', () => {
  const has = (n: string) => !!(SPECS as any[]).find((s) => s.name === n).schema.properties.screenshot;
  for (const n of ['desktop_app_click', 'desktop_app_type', 'desktop_app_key', 'desktop_app_scroll']) assert.equal(has(n), true, n);
  for (const n of ['desktop_app_screenshot', 'desktop_app_menu', 'desktop_app_batch']) assert.equal(has(n), false, n);
});

test('without the flag the result is the record alone; with it the record leads and the capture of the window follows', async () => {
  const r = await rig();
  await r.shoot();
  const plain = await r.call('desktop_app_click', click);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].type, 'text');
  const before = r.callsOf('app.screenshot').length;
  const withShot = await r.call('desktop_app_click', { ...click, screenshot: true });
  assert.equal(withShot[0].type, 'text');
  assert.ok(JSON.parse(withShot[0].text).effect, 'the record is first');
  assert.equal(withShot[1].text, 'The window after this action:');
  assert.ok(
    withShot.slice(2).some((c: any) => c.type === 'image'),
    'the capture comes with its image',
  );
  assert.equal(r.callsOf('app.screenshot').length, before + 1, 'one capture, taken after the click');
  assert.ok(r.callsOf('app.click').length >= 1);
  // a flag that is not exactly true asks for nothing
  const off = await r.call('desktop_app_click', { ...click, screenshot: 'yes' });
  assert.equal(off.length, 1);
});

test('a capture that fails after the action leaves the record and says so; an action that fails brings no capture', async () => {
  const r = await rig();
  await r.shoot();
  const was = r.helper.answers['app.screenshot'];
  r.helper.answers['app.screenshot'] = () => {
    throw helperFailure('window_gone', 'window gone');
  };
  const out = await r.call('desktop_app_click', { ...click, screenshot: true });
  assert.ok(JSON.parse(out[0].text).effect);
  assert.match(out[1].text, /The capture after this action failed .*the action ran as recorded above/);
  assert.equal(out.length, 2);
  // a failure with no message still reads
  r.helper.answers['app.screenshot'] = () => {
    throw 'no frame';
  };
  const bare = await r.call('desktop_app_click', { ...click, screenshot: true });
  assert.match(bare[1].text, /failed \(no frame\)/);
  r.helper.answers['app.screenshot'] = was;
  const shots = r.callsOf('app.screenshot').length;
  r.helper.answers['app.click'] = () => {
    throw helperFailure('target_refused', 'refused: target is X');
  };
  await assert.rejects(r.call('desktop_app_click', { ...click, screenshot: true }));
  assert.equal(r.callsOf('app.screenshot').length, shots, 'no capture after a failed action');
});

test('key and scroll bring the capture too, from the same flag (type shares the same path)', async () => {
  const r = await rig();
  await r.shoot();
  const calls: [string, any][] = [
    ['desktop_app_key', { app: 'Notes', combo: 'tab', target: 'focused', screenshot: true }],
    ['desktop_app_scroll', { app: 'Notes', coordinate: [130, 70], dy: 2, screenshot: true }],
  ];
  for (const [tool, args] of calls) {
    const out = await r.call(tool, args);
    assert.equal(out[1]?.text, 'The window after this action:', tool);
    assert.ok(
      out.some((c: any) => c.type === 'image'),
      tool,
    );
  }
});

test('a separate screenshot soon after an action in the same window says the action could have carried it; later, elsewhere or after the flag it does not', async () => {
  const hint = (o: any[]) => o.some((c: any) => /Next time pass screenshot: true/.test(c.text ?? ''));
  const r = await rig();
  const first = await r.shoot();
  assert.equal(hint(first.content ?? first), false, 'no action yet');
  await r.call('desktop_app_click', click);
  assert.equal(hint(await r.call('desktop_app_screenshot', { app: 'Notes' })), true);
  assert.equal(hint(await r.call('desktop_app_screenshot', { app: 'Notes' })), false, 'said once per action');
  await r.call('desktop_app_click', { ...click, screenshot: true });
  assert.equal(hint(await r.call('desktop_app_screenshot', { app: 'Notes' })), false, 'that action carried its capture');
  const now = Date.now;
  await r.call('desktop_app_click', click);
  Date.now = () => now() + 60000;
  try {
    assert.equal(hint(await r.call('desktop_app_screenshot', { app: 'Notes' })), false, 'a minute later');
  } finally {
    Date.now = now;
  }
});
