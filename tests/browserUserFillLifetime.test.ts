// Saved-login request lifetimes across browser navigation, closure and native approval; all boundaries are in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { fillLogin, touchIdConfirm } = require('../electron/capabilities/browser/userFill.cjs');
const tick = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
function setup(options: any = {}) {
  const wc: any = new EventEmitter();
  let url = options.url || 'https://approved.example/login';
  let loading = !!options.loading;
  let destroyed = false;
  const steps: { step: string; url: string }[] = [],
    typed: { value: string; url: string }[] = [];
  wc.getURL = () => url;
  wc.isDestroyed = () => destroyed;
  wc.isLoadingMainFrame = () => loading;
  wc.startNavigation = (main = true, legacy = false) => {
    if (main) loading = true;
    wc.emit('did-start-navigation', legacy ? {} : { isMainFrame: main }, url, false, main);
  };
  wc.finishNavigation = (next = url) => {
    url = next;
    loading = false;
    wc.emit('did-stop-loading');
  };
  wc.destroy = () => {
    destroyed = true;
    wc.emit('destroyed');
  };
  wc.executeJavaScriptInIsolatedWorld = async (_world, [{ code }]) => {
    // Electron v44.7.0 lib/browser/api/web-contents.ts: waitTillCanExecuteJavaScript
    // waits for did-stop-loading, then executes in the CURRENT renderer (not the originating document).
    if (!wc.getURL() || wc.isLoadingMainFrame()) await new Promise((r) => wc.once('did-stop-loading', r));
    const step = JSON.parse(/const step = (".*?");/.exec(code)![1]);
    steps.push({ step, url });
    if (options.holdStep === step) await options.hold.promise;
    if (options.rejectStep === step) throw new Error('synthetic renderer failure');
    if (step === 'probe') return 'found' in options ? options.found : { username: true, password: true };
    return options.focus !== false;
  };
  wc.insertText = async (value) => {
    typed.push({ value, url });
    options.afterInsert?.(wc, value);
    if (options.insertHold) await options.insertHold.promise;
  };
  const store = {
    list: () => (options.missing ? [] : [{ id: 'fake' }]),
    get: () => {
      options.afterGet?.(wc);
      return options.removed ? null : { username: options.emptyUser ? '' : 'TEST_USER', password: 'NONSECRET_TEST_SENTINEL' };
    },
  };
  const run = (confirm?: any) => fillLogin({ wc, store, id: 'fake', ...(confirm ? { confirm } : {}) });
  const clean = () => {
    assert.equal(wc.listenerCount('destroyed'), 0);
    assert.equal(wc.listenerCount('did-start-navigation'), 0);
  };
  return { wc, run, clean, steps, typed };
}
test('pending navigation after approval cannot execute the fill on the next renderer', async () => {
  const f = setup();
  const result = f.run(async () => {
    f.wc.startNavigation();
    return true;
  });
  await tick();
  f.wc.finishNavigation('https://replacement.example/login');
  assert.equal(await result, 'origin_changed');
  assert.deepEqual(f.typed, []);
  f.clean();
});
for (const stage of ['probe', 'username', 'password']) {
  test(`same-URL navigation during awaited ${stage} retires the document`, async () => {
    const hold = deferred();
    const f = setup({ holdStep: stage, hold });
    const result = f.run();
    await tick();
    assert.equal(f.steps.at(-1)!.step, stage);
    f.wc.startNavigation(true, true);
    f.wc.finishNavigation();
    const count = f.typed.length;
    hold.resolve();
    assert.equal(await result, 'origin_changed');
    assert.equal(f.typed.length, count);
    f.clean();
  });
}
test('same-origin replacement during native confirmation retires the document', async () => {
  const hold = deferred();
  const f = setup();
  const result = f.run(() => hold.promise);
  await tick();
  f.wc.startNavigation();
  f.wc.finishNavigation('https://approved.example/other');
  hold.resolve(true);
  assert.equal(await result, 'origin_changed');
  assert.deepEqual(f.typed, []);
  f.clean();
});
test('destroyed page after focus cannot type, and a replacement request still succeeds', async () => {
  const hold = deferred();
  const f = setup({ holdStep: 'password', hold });
  const result = f.run();
  await tick();
  f.wc.destroy();
  hold.resolve();
  assert.equal(await result, 'origin_changed');
  assert.equal(f.typed.length, 1);
  f.clean();
  const fresh = setup();
  assert.equal(await fresh.run(), 'filled');
  assert.equal(fresh.typed.length, 2);
  fresh.clean();
});
test('already loading page is refused before probing or approval', async () => {
  const f = setup({ loading: true });
  let asked = 0;
  const result = f.run(async () => {
    asked++;
    return true;
  });
  await tick();
  f.wc.finishNavigation();
  assert.equal(await result, 'origin_changed');
  assert.equal(asked, 0);
  assert.deepEqual(f.steps, []);
  f.clean();
});
test('subframe navigation does not retire the main document', async () => {
  const f = setup();
  assert.equal(
    await f.run(async () => {
      f.wc.startNavigation(false);
      return true;
    }),
    'filled',
  );
  assert.equal(f.typed.length, 2);
  f.clean();
});
test('navigation after username insertion stops before password and releases listeners', async () => {
  const f = setup({
    afterInsert: (wc) => {
      wc.startNavigation();
      wc.finishNavigation();
    },
  });
  assert.equal(await f.run(), 'origin_changed');
  assert.equal(f.typed.length, 1);
  f.clean();
});
test('ordinary failure outcomes retain cleanup and no typing', async () => {
  for (const [opts, confirm, status] of [
    [{ missing: true }, undefined, 'not_found'],
    [{ url: 'about:blank' }, undefined, 'not_found'],
    [{ found: { username: false, password: false } }, undefined, 'no_fields'],
    [{ found: null }, undefined, 'no_fields'],
    [{}, async () => false, 'cancelled'],
    [{ removed: true }, undefined, 'not_found'],
    [{ focus: false }, undefined, 'failed'],
    [{ rejectStep: 'probe' }, undefined, 'failed'],
  ] as any[]) {
    const f = setup(opts);
    assert.equal(await f.run(confirm), status);
    assert.deepEqual(f.typed, []);
    f.clean();
  }
});
test('loading, destroyed and changed URL checks also fail closed independently of navigation events', async () => {
  const destroyed = setup();
  destroyed.wc.destroy();
  assert.equal(await destroyed.run(), 'origin_changed');
  destroyed.clean();
  const changed = setup();
  assert.equal(
    await changed.run(async () => {
      changed.wc.finishNavigation('https://replacement.example/');
      return true;
    }),
    'origin_changed',
  );
  changed.clean();
  const duringRead = setup({ afterGet: (wc) => wc.startNavigation() });
  assert.equal(await duringRead.run(), 'origin_changed');
  duringRead.clean();
});
test('password-only form and empty user name still fill without extra typing', async () => {
  for (const options of [{ found: { username: false, password: true } }, { emptyUser: true }]) {
    const f = setup(options);
    assert.equal(await f.run(), 'filled');
    assert.deepEqual(
      f.typed.map((x) => x.value),
      ['NONSECRET_TEST_SENTINEL'],
    );
    f.clean();
  }
});
test('Touch ID adapters keep approval semantics and fail closed on refusal', async () => {
  assert.equal(await touchIdConfirm(undefined)('approved.example'), true);
  assert.equal(await touchIdConfirm({ canPromptTouchID: () => false })('approved.example'), true);
  const reasons: string[] = [];
  assert.equal(
    await touchIdConfirm({ canPromptTouchID: () => true, promptTouchID: async (reason) => reasons.push(reason) })('approved.example'),
    true,
  );
  assert.deepEqual(reasons, ['fill your login for approved.example']);
  assert.equal(
    await touchIdConfirm({
      canPromptTouchID: () => true,
      promptTouchID: async () => {
        throw new Error('cancelled');
      },
    })('approved.example'),
    false,
  );
});
for (const boundary of ['probe', 'confirmation', 'username', 'password', 'insert']) {
  for (const end of ['navigate', 'destroy']) {
    test(`${end} settles a never-answering ${boundary} request and observes its late rejection`, async () => {
      const hold = deferred();
      const f = setup(boundary === 'insert' ? { insertHold: hold } : { holdStep: boundary, hold });
      const operation = f.run(boundary === 'confirmation' ? () => hold.promise : undefined);
      let settled: string | undefined;
      operation.then((status) => {
        settled = status;
      });
      await tick();
      const typed = f.typed.length;
      if (end === 'destroy') f.wc.destroy();
      else f.wc.startNavigation();
      await tick();
      assert.equal(settled, 'origin_changed', 'retirement must not need a response from the retired renderer');
      f.clean();
      hold.reject(new Error('late synthetic failure'));
      await tick();
      assert.equal(f.typed.length, typed);
      assert.equal(await operation, 'origin_changed');
    });
  }
}
