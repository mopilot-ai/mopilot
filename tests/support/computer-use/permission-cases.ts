// Computer-use permission cases registered by the original unit-test entrypoint.
import { test, assert, permissionDenied, permissionRig, permissionIpcRig } from './fixture.ts';

export function registerPermissionCases() {
  test('working thumbnail IPC retires the prior turn capture and cached target for the same chat and app', async () => {
    const r = permissionIpcRig();
    try {
      let resolve!: (value: any) => void;
      let shots = 0;
      r.runtime.helper.permissionStatus = async () => ({ screenRecording: true });
      r.runtime.helper.resolveApps = async () => ({ apps: [{ app: { bundleId: 'current.bundle', running: true, pid: 42 } }] });
      r.runtime.helper.call = () =>
        ++shots === 1
          ? new Promise((answer) => {
              resolve = answer;
            })
          : Promise.resolve({ jpeg: 'NEW' });
      const old = r.thumbnail('turn-one');
      await new Promise((answer) => setImmediate(answer));
      const current = r.thumbnail('turn-two');
      assert.notEqual(current, old);
      assert.deepEqual(await current, { thumbnail: 'data:image/jpeg;base64,NEW', bundleId: 'current.bundle' });
      resolve({ jpeg: 'OLD' });
      assert.deepEqual(await old, { thumbnail: null, bundleId: null });
      assert.equal(r.thumbnail('turn-two'), current);
      assert.notEqual(r.thumbnail('turn-three'), current, 'settled images also belong to their turn');
      await r.thumbnail('turn-three');
    } finally {
      r.done();
    }
  });

  for (const retirement of ['switch off', 'helper exit', 'shutdown', 'stop']) {
    test(`working thumbnails retire pending permission and cache on ${retirement}`, async () => {
      const r = permissionIpcRig();
      try {
        let resolve!: (value: any) => void;
        let resolutions = 0;
        r.runtime.helper.permissionStatus = () =>
          new Promise((answer) => {
            resolve = answer;
          });
        r.runtime.helper.resolveApps = async () => {
          resolutions++;
          return { apps: [{ app: { bundleId: 'com.apple.TextEdit', running: true, pid: 42 } }] };
        };
        r.runtime.helper.call = async () => ({ jpeg: 'NEW' });
        r.runtime.helper.stop = () => {};
        const old = r.thumbnail();
        await new Promise((answer) => setImmediate(answer));
        if (retirement === 'switch off') {
          r.disable();
          r.runtime.sync();
          r.enable();
          r.runtime.sync();
        } else if (retirement === 'helper exit') r.runtime.helper.emit('exit');
        else if (retirement === 'shutdown') await r.runtime.letGo();
        else r.runtime.stop();
        resolve({ screenRecording: true });
        assert.deepEqual(await old, { thumbnail: null, bundleId: null });
        assert.equal(resolutions, 0);
        let permissions = 0;
        r.runtime.helper.permissionStatus = async () => {
          permissions++;
          return { screenRecording: false };
        };
        assert.deepEqual(await r.thumbnail(), { thumbnail: null, bundleId: null });
        assert.equal(
          permissions,
          retirement === 'shutdown' || retirement === 'stop' ? 0 : 1,
          'retired probes cannot authorize a new helper or run after shutdown',
        );
      } finally {
        r.done();
      }
    });
  }

  test('native permission: asks macOS and retries a screenshot when the grant takes effect', async () => {
    const r = permissionRig();
    const shot = r.helper.screenshot;
    let allowed = false;
    (r.helper as any).screenshot = async (...args: any[]) => {
      if (!allowed) throw permissionDenied();
      return shot(...args);
    };
    (r.helper as any).requestPermission = async (kind: string) => {
      r.requested.push(kind);
      allowed = true;
      return { screenRecording: true };
    };
    try {
      const out = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
      assert.equal(out.ok, true, JSON.stringify(out.error));
      assert.deepEqual(r.requested, ['screenRecording']);
      assert.equal(
        out.content.some((c: any) => c.type === 'image'),
        true,
      );
      assert.equal(r.cu.blocked.size, 0);
    } finally {
      r.done();
    }
  });

  test('native permission: denial shows the guide and does not repeatedly prompt', async () => {
    const r = permissionRig();
    (r.helper as any).screenshot = async () => {
      throw permissionDenied();
    };
    (r.helper as any).requestPermission = async (kind: string) => (r.requested.push(kind), { screenRecording: false });
    try {
      for (let i = 0; i < 2; i++) {
        const out = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
        assert.equal(out.error.code, 'permission');
        assert.match(out.error.message, /switch is already on/);
      }
      assert.deepEqual(r.requested, ['screenRecording']);
      assert.equal(r.cu.blocked.has('c1'), true);
      assert.equal(r.activity.at(-1).value.permission, 'screenRecording');
    } finally {
      r.done();
    }
  });

  test('native permission: a request failure preserves the permission error and guide, and the next call asks again', async () => {
    const r = permissionRig();
    (r.helper as any).screenshot = async () => {
      throw permissionDenied();
    };
    let asked = 0;
    (r.helper as any).requestPermission = async () => {
      asked++;
      throw new Error('helper disconnected');
    };
    try {
      const out = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
      assert.equal(out.error.code, 'permission');
      assert.equal(r.cu.blocked.has('c1'), true);
      // a request that could not be made is not remembered as macOS's answer
      assert.equal((await r.reg.invoke('c1', 'c1', 'computer_screenshot', {})).error.code, 'permission');
      assert.equal(asked, 2);
    } finally {
      r.done();
    }
  });

  test('native permission: a positive request followed by stale access stops after one retry', async () => {
    const r = permissionRig();
    let attempts = 0;
    (r.helper as any).screenshot = async () => {
      attempts++;
      throw permissionDenied();
    };
    (r.helper as any).requestPermission = async (kind: string) => (r.requested.push(kind), { screenRecording: true });
    try {
      const out = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
      assert.equal(out.error.code, 'permission');
      assert.equal(attempts, 2);
      assert.deepEqual(r.requested, ['screenRecording']);
    } finally {
      r.done();
    }
  });

  test('native permission: simultaneous chats share one pending system request', async () => {
    const r = permissionRig();
    let allowed = false;
    const shot = r.helper.screenshot;
    (r.helper as any).screenshot = async (...args: any[]) => {
      if (!allowed) throw permissionDenied();
      return shot(...args);
    };
    (r.helper as any).requestPermission = async (kind: string) => {
      r.requested.push(kind);
      await new Promise((resolve) => setImmediate(resolve));
      allowed = true;
      return { screenRecording: true };
    };
    try {
      const out = await Promise.all(['c1', 'c2'].map((id) => r.reg.invoke(id, id, 'computer_screenshot', {})));
      assert.deepEqual(
        out.map((x: any) => x.ok),
        [true, true],
      );
      assert.deepEqual(r.requested, ['screenRecording']);
    } finally {
      r.done();
    }
  });

  test('native permission: a failed follow-up screenshot never replays input', async () => {
    for (const [tool, args, method] of [
      ['computer_click', { x: 20, y: 10 }, 'click'],
      ['computer_type', { text: 'hello' }, 'type'],
      ['computer_key', { key: 'cmd+a' }, 'key'],
      ['computer_scroll', { x: 20, y: 10, dy: 40 }, 'scroll'],
    ] as const) {
      const r = permissionRig();
      (r.helper as any).screenshot = async () => {
        throw permissionDenied();
      };
      (r.helper as any).requestPermission = async (kind: string) => (r.requested.push(kind), { screenRecording: true });
      try {
        const out = await r.reg.invoke('c1', 'c1', tool, args);
        assert.equal(out.error.code, 'permission', tool);
        assert.equal(r.helper.calls.filter((c) => c.method === method).length, 1, tool);
        assert.deepEqual(r.requested, ['screenRecording'], tool);
      } finally {
        r.done();
      }
    }
  });

  test('native permission: unattended calls do not open a system prompt', async () => {
    const r = permissionRig();
    r.cu.unattended = async () => 'a scheduled task';
    (r.helper as any).screenshot = async () => {
      throw permissionDenied();
    };
    (r.helper as any).requestPermission = async (kind: string) => (r.requested.push(kind), { screenRecording: true });
    try {
      const out = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
      assert.equal(out.error.code, 'permission');
      assert.deepEqual(r.requested, []);
    } finally {
      r.done();
    }
  });

  test('native permission: an Accessibility grant can retry the element list', async () => {
    const r = permissionRig();
    const snapshot = r.helper.axSnapshot;
    let allowed = false;
    (r.helper as any).axSnapshot = async (...args: any[]) => {
      if (!allowed) throw permissionDenied('accessibility');
      return snapshot(...args);
    };
    (r.helper as any).requestPermission = async (kind: string) => {
      r.requested.push(kind);
      allowed = true;
      return { accessibility: true };
    };
    try {
      const out = await r.reg.invoke('c1', 'c1', 'computer_elements', {});
      assert.equal(out.ok, true, JSON.stringify(out.error));
      assert.deepEqual(r.requested, ['accessibility']);
    } finally {
      r.done();
    }
  });

  test('native permission IPC: starts the helper, requests the chosen grant and refreshes settings', async () => {
    const r = permissionIpcRig();
    try {
      assert.equal(await r.request('screenRecording'), true);
      assert.deepEqual(r.calls, ['start', 'screenRecording']);
      assert.deepEqual(r.broadcasts, [['computer:changed', { chatId: null }]]);
    } finally {
      r.done();
    }
  });

  test('native permission IPC: invalid kinds and a disabled feature never reach the helper', async () => {
    const r = permissionIpcRig();
    try {
      assert.equal(await r.request('invalid'), false);
      r.disable();
      assert.equal(await r.request('accessibility'), false);
      assert.deepEqual(r.calls, []);
    } finally {
      r.done();
    }
  });

  test('native permission IPC: denial refreshes settings; a helper failure returns false', async () => {
    const r = permissionIpcRig();
    try {
      r.runtime.helper.requestPermission = async () => ({ screenRecording: false });
      assert.equal(await r.request('screenRecording'), false);
      assert.equal(r.broadcasts.length, 1);
      r.runtime.helper.start = async () => {
        throw new Error('cannot start');
      };
      assert.equal(await r.request('screenRecording'), false);
      assert.equal(r.broadcasts.length, 1);
    } finally {
      r.done();
    }
  });
}
