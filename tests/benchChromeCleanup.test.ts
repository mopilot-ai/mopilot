// Bench browser cleanup admits only exact profile PIDs and closes their windows/sheets with bounded verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const { chromeCleanupPlan, chromeCleanupScript } = await import('../bench/lib/chromeCleanup.mjs');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('browser ownership rejects default, foreign, duplicate and ambiguous profile arguments', () => {
  assert.deepEqual(
    chromeCleanupPlan(`1 Google Chrome ${chrome} --user-data-dir=/bench profile --no-startup-window\n2 helper`, '/bench profile'),
    {
      owned: [1],
      blocked: [],
    },
  );
  for (const args of [
    '',
    '--user-data-dir=/other',
    '--user-data-dir=/bench --user-data-dir=/bench',
    '--user-data-dir=/bench https://secret/token',
  ]) {
    const result = chromeCleanupPlan(`3 Google Chrome ${chrome} ${args}`, '/bench');
    assert.deepEqual(result.owned, []);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].includes('secret'), false);
  }
  assert.deepEqual(chromeCleanupPlan(`5 bash /bin/bash -c ${chrome} --user-data-dir=/bench`, '/bench'), { owned: [], blocked: [] });
  assert.deepEqual(chromeCleanupPlan(`4 Google Chrome ${chrome} --user-data-dir=/bench`, '').owned, []);
});
function cleanup(kind: string) {
  let windows: any[] = [];
  let cancelled = 0;
  let closed = 0;
  let rounds = 0;
  const button = {
    subrole: () => 'AXCloseButton',
    click: () => {
      closed++;
      if (kind !== 'stuck') windows = [];
    },
  };
  const cancel = {
    name: () => "Don't Save",
    click: () => {
      cancelled++;
    },
  };
  windows = [
    {
      sheets: () =>
        kind === 'throw'
          ? (() => {
              throw Error('AX denied');
            })()
          : [{ buttons: () => (kind === 'no-controls' ? [] : [{ name: () => 'Save' }, cancel]) }],
      buttons: () => (kind === 'no-controls' ? [] : [{ subrole: () => 'AXOther' }, button]),
    },
  ];
  const process = { name: () => (kind === 'reused' ? 'Other App' : 'Google Chrome'), windows: () => windows };
  const result = vm.runInNewContext(chromeCleanupScript([123]), {
    Application: (name: string) => {
      assert.equal(name, 'System Events');
      return {
        processes: {
          whose: ({ unixId }: any) => {
            assert.equal(unixId, 123);
            return () => (kind === 'gone' ? [] : [process]);
          },
        },
      };
    },
    delay: () => {
      rounds++;
    },
  });
  return { left: JSON.parse(result), cancelled, closed, rounds };
}
test('owned mark/prior-task window and sheet close; another instance is never enumerated', () => {
  assert.deepEqual(cleanup('normal'), { left: [], cancelled: 1, closed: 1, rounds: 1 });
  assert.deepEqual(cleanup('gone'), { left: [], cancelled: 0, closed: 0, rounds: 0 });
});
test('unclosed dialogs, missing controls, stale PID identity and AX failure fail closed', () => {
  for (const kind of ['stuck', 'no-controls']) {
    const r = cleanup(kind);
    assert.match(r.left[0], /windows or dialogs remain/);
    assert.equal(r.rounds, 3);
  }
  assert.match(cleanup('reused').left[0], /changed owner/);
  assert.match(cleanup('throw').left[0], /could not be verified/);
});

test('no-argument browser is default profile and never owned', () => {
  assert.equal(chromeCleanupPlan(`6 Google Chrome ${chrome}`, '/bench').blocked.length, 1);
});
test('index-based AX windows close from last to first and Leave takes precedence', () => {
  const windows = ['mark', 'prior-task'];
  const closed: string[] = [];
  const answers: string[] = [];
  const p = {
    name: () => 'Google Chrome',
    windows: () =>
      windows.map((_, index) => ({
        sheets: () => [{ buttons: () => ['Cancel', 'Leave'].map((name) => ({ name: () => name, click: () => answers.push(name) })) }],
        buttons: () => [
          {
            subrole: () => 'AXCloseButton',
            click: () => {
              assert.ok(windows[index], 'AX index was invalidated by an earlier close');
              closed.push(windows[index]);
              windows.splice(index, 1);
            },
          },
        ],
      })),
  };
  const out = vm.runInNewContext(chromeCleanupScript([123]), {
    Application: () => ({ processes: { whose: () => () => [p] } }),
    delay: (seconds: number) => assert.equal(seconds, 1),
  });
  assert.deepEqual(JSON.parse(out), []);
  assert.deepEqual(closed, ['prior-task', 'mark']);
  assert.deepEqual(answers, ['Leave', 'Leave']);
});

test('a beforeunload dialog that is its own window, not a sheet, is answered with Leave', () => {
  // Chrome shows it as a top-level AXDialog with Cancel and Leave and no close button (seen in the bench VM, #3835)
  // AX lists the dialog first, as observed; the cleanup walks windows last to first
  const windows = ['dialog', 'form'];
  const answers: string[] = [];
  const named = (name: string, click: () => void) => ({ name: () => name, subrole: () => 'AXButton', click });
  const p = {
    name: () => 'Google Chrome',
    windows: () =>
      windows.map((title) => ({
        sheets: () => [],
        buttons: () =>
          title === 'dialog'
            ? [
                named('Cancel', () => answers.push('Cancel')),
                named('Leave', () => {
                  answers.push('Leave');
                  windows.length = 0;
                }),
              ]
            : [{ subrole: () => 'AXCloseButton', click: () => answers.push('close form') }],
      })),
  };
  const out = vm.runInNewContext(chromeCleanupScript([123]), {
    Application: () => ({ processes: { whose: () => () => [p] } }),
    delay: () => {},
  });
  assert.deepEqual(JSON.parse(out), []);
  assert.deepEqual(answers, ['close form', 'Leave']);
});

test('a dialog window with neither Leave nor a close button stays reported, never cancelled', () => {
  const answers: string[] = [];
  const p = {
    name: () => 'Google Chrome',
    windows: () => [
      {
        sheets: () => [],
        buttons: () => [{ name: () => 'Cancel', subrole: () => 'AXButton', click: () => answers.push('Cancel') }],
      },
    ],
  };
  const out = vm.runInNewContext(chromeCleanupScript([123]), {
    Application: () => ({ processes: { whose: () => () => [p] } }),
    delay: () => {},
  });
  assert.deepEqual(JSON.parse(out), ['Chrome pid 123 windows or dialogs remain']);
  assert.deepEqual(answers, []);
});

test('spaced Chrome install paths are admitted or blocked, never ignored', () => {
  const spaced = '/Users/admin/Test Apps/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.deepEqual(chromeCleanupPlan(`11 Google Chrome ${spaced} --user-data-dir=/bench`, '/bench'), { owned: [11], blocked: [] });
  assert.equal(chromeCleanupPlan(`12 Google Chrome ${spaced} --user-data-dir=/foreign`, '/bench').blocked.length, 1);
});

test('kernel process name excludes helpers and wrappers; unknown browser executable fails closed', () => {
  const ps = `20 Google Chrome Helper /Applications/Google Chrome.app/Contents/Frameworks/Helper
21 bash /bin/bash -c /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
22 Google Chrome /custom/renamed-chrome --user-data-dir=/bench`;
  const r = chromeCleanupPlan(ps, '/bench');
  assert.deepEqual(r.owned, []);
  assert.equal(r.blocked.length, 1);
  assert.match(r.blocked[0], /pid 22/);
});
