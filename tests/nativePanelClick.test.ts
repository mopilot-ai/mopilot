// The real native-panel click helper checks its DOM hit target again when separate CDP calls let layout move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { clickNativePanel } from './e2e/fixtures/nativePanelClick.mjs';

function fixture() {
  const scene = { x: 0, y: 0, missing: false, disabled: false, hidden: false, covered: false };
  const events: any[] = [];
  const clicks: string[] = [];
  const waits: number[] = [];
  let onMove = () => {};
  let onWait = () => {};
  const button = {
    get disabled() {
      return scene.disabled;
    },
    scrollIntoView() {},
    getBoundingClientRect: () => ({ x: scene.x, y: scene.y, width: 10, height: scene.hidden ? 0 : 10 }),
    contains: (target: unknown) => target === button,
  };
  const container = {};
  const at = (x: number, y: number) =>
    !scene.covered && !scene.missing && !scene.hidden && x >= scene.x && x < scene.x + 10 && y >= scene.y && y < scene.y + 10
      ? button
      : container;
  const document = { querySelector: () => (scene.missing ? null : button), elementFromPoint: at };
  const boundary = {
    inPanel: async (expression: string) => runInNewContext(expression, { document }),
    send: async (event: Record<string, unknown>) => {
      events.push(event);
      if (event.type === 'mouseMoved') onMove();
      if (event.type === 'mousePressed') clicks.push(at(event.x as number, event.y as number) === button ? 'button' : 'container');
    },
    delay: async (ms: number) => {
      waits.push(ms);
      onWait();
    },
  };
  return {
    scene,
    events,
    clicks,
    waits,
    boundary,
    move: (fn: () => void) => {
      onMove = fn;
    },
    wait: (fn: () => void) => {
      onWait = fn;
    },
  };
}

test('a layout change after moving the native pointer cannot turn a dismiss-button click into a container click', async () => {
  const f = fixture();
  let moved = false;
  f.move(() => {
    if (!moved) f.scene.y = 20;
    moved = true;
  });
  await clickNativePanel(f.boundary, '#refusal-off');
  assert.deepEqual(f.clicks, ['button']);
  assert.equal(f.events.filter((e) => e.type === 'mouseReleased').length, 1);
});

test('a disappearing, disabled, hidden or covered control is retried before trusted input', async () => {
  for (const state of ['missing', 'disabled', 'hidden', 'covered'] as const) {
    const f = fixture();
    f.scene[state] = true;
    f.wait(() => {
      f.scene[state] = false;
    });
    await clickNativePanel(f.boundary, '#refusal-off');
    assert.deepEqual(f.clicks, ['button'], state);
    assert.ok(f.waits.length >= 2, 'availability alone cannot skip the stability sample');
  }
});

test('a covered target after hover retires the point and waits for the real control', async () => {
  const f = fixture();
  let moved = false;
  f.move(() => {
    if (!moved) f.scene.covered = true;
    moved = true;
  });
  f.wait(() => {
    f.scene.covered = false;
  });
  await clickNativePanel(f.boundary, '#refusal-off');
  assert.deepEqual(f.clicks, ['button']);
  assert.equal(f.events.filter((e) => e.type === 'mousePressed').length, 1);
});

test('a missing control or one moving continuously reaches its bounded failure without pressing', async () => {
  for (const moving of [false, true]) {
    const f = fixture();
    f.scene.missing = !moving;
    if (moving)
      f.wait(() => {
        f.scene.y++;
      });
    await assert.rejects(
      clickNativePanel(f.boundary, '#refusal-off'),
      moving ? /did not settle: #refusal-off/ : /unavailable: #refusal-off/,
    );
    assert.equal(f.waits.length, 100);
    assert.equal(f.clicks.length, 0);
    assert.equal(f.events.length, 0);
  }
});

test('layout changes between samples, including returning to a prior point, require a new stable sample', async () => {
  const f = fixture();
  const positions = [20, 0, 40, 40];
  f.wait(() => {
    f.scene.y = positions.shift() ?? 40;
  });
  await clickNativePanel(f.boundary, '#refusal-off');
  assert.deepEqual(f.clicks, ['button']);
  assert.equal(f.events.find((e) => e.type === 'mousePressed').y, 45);
});

test('horizontal movement also invalidates the point, and the default polling delay still permits a stable click', async () => {
  const f = fixture();
  f.wait(() => {
    f.scene.x = 20;
  });
  await clickNativePanel(f.boundary, '#refusal-off');
  assert.equal(f.events.find((e) => e.type === 'mousePressed').x, 25);
  const g = fixture();
  const { delay: _delay, ...boundary } = g.boundary;
  await clickNativePanel(boundary, '#refusal-off');
  assert.deepEqual(g.clicks, ['button']);
});

test('a failed acknowledgement still releases the trusted pointer and propagates the failure', async () => {
  const f = fixture();
  await assert.rejects(
    clickNativePanel(f.boundary, '#refusal-off', 0, async () => {
      throw new Error('not acknowledged');
    }),
    /not acknowledged/,
  );
  assert.deepEqual(
    f.events.map((e) => e.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
  );
});

test('a failed panel read or pointer move propagates without pressing a stale point', async () => {
  const f = fixture();
  await assert.rejects(
    clickNativePanel(
      {
        ...f.boundary,
        inPanel: async () => {
          throw new Error('panel closed');
        },
      },
      '#refusal-off',
    ),
    /panel closed/,
  );
  await assert.rejects(
    clickNativePanel(
      {
        ...f.boundary,
        send: async () => {
          throw new Error('CDP disconnected');
        },
      },
      '#refusal-off',
    ),
    /CDP disconnected/,
  );
  assert.equal(f.clicks.length, 0);
});
