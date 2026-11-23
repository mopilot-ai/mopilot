// Capability-reason presentation on both native-control settings surfaces, and MoPilot's own Chrome extension's row with its install link and Pair (#1632), sharing the native UI fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { capabilityReasonText, UNKNOWN_CAPABILITY_REASON } from '../../../shared/capabilityReasons.mjs';
import { MOPILOT_CHROME_EXTENSION } from '../../e2e/fixtures/chromeExtension.ts';
import { availabilityStatus, facts, healthOf, live } from './fixture.ts';

const require = createRequire(import.meta.url);
const { chromeRelayHealth } = require('../../../electron/capabilities/capabilityHealth.cjs');

export function registerPresentationUI({
  f,
  reset,
  STATUS,
  surface,
  mount,
  NativeControlStatus,
  ComputerUseSettings,
  computerStatus,
}: Record<string, any>) {
  test('the E2E own-extension wording accepts both apostrophes and rejects other Chrome routes', () => {
    for (const apostrophe of ["'", '’'])
      for (const chrome of ['', 'Chrome ']) assert.match(`MoPilot${apostrophe}s ${chrome}extension`, MOPILOT_CHROME_EXTENSION);
    for (const text of [
      '',
      'Use Your Chrome',
      'Playwright Extension',
      'Native (Claude in Chrome)',
      "MoPilot's Chrome relay",
      'This feature needs attention. Open its settings to check.',
      'MoPilotXs Chrome extension',
    ])
      assert.doesNotMatch(text, MOPILOT_CHROME_EXTENSION);
  });

  test('the migration E2E expectation matches the rendered page in every pairing state: the extension’s row, no Claude row', async () => {
    for (const connection of [
      { paired: false, connected: false },
      { paired: true, connected: false },
      { paired: true, connected: true },
    ]) {
      const status = availabilityStatus(
        facts(),
        live({
          codexNative: false,
          claudeFlag: false,
          claudeEligible: false,
          health: {
            ...healthOf(),
            chromeRelay: {
              ...chromeRelayHealth({ enabled: true, running: true, kind: 'extension', ...connection }),
              channel: 'extension',
            },
          },
          chromeServed: { tools: true, codex: true, takeover: false, kind: 'extension' },
        }),
      );
      reset(async () => status);
      const m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
      try {
        // Claude uses MoPilot's extension, so the extension's row speaks for it (tests/e2e/browser.spec.ts)
        assert.ok(m.host.querySelector('[data-title="MoPilot extension"]'));
        assert.equal(m.host.querySelector('[data-title="Claude Code · Chrome"]'), null);
        assert.doesNotMatch(m.host.textContent ?? '', /Use Your Chrome/);
      } finally {
        await m.close();
      }
    }
  });

  test('Computer use settings: the Codex row names the installed Codex Computer Use version, and the permissions it needs', async () => {
    const codexComputer = (s: any) => ({ ...STATUS, harnesses: [{ ...STATUS.harnesses[0], computer: s }, ...STATUS.harnesses.slice(1)] });
    reset(async () =>
      codexComputer({ ...surface('native', 'Native (Codex Computer Use)'), version: 'Codex Computer Use 26.1005.1001425' }),
    );
    let m = await mount(createElement(NativeControlStatus, { surface: 'computer' }));
    try {
      assert.deepEqual(m.rows()[0], [
        'Codex · Computer',
        'Native (Codex Computer Use)',
        'status-pill native-status ok',
        'Codex Computer Use 26.1005.1001425.',
        [],
      ]);
    } finally {
      await m.close();
    }
    const detail =
      'Codex Computer Use needs Accessibility and Screen & System Audio Recording. In System Settings → Privacy & Security, turn on “Codex Computer Use” in both lists, then choose Check again. Already on? It may still belong to an older copy of Codex Computer Use: in both lists, select Codex Computer Use, remove it with −, add it again with +, then choose Check again.';
    const ax = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
    const sr = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    reset(async () =>
      codexComputer({
        ...surface('permissions', 'Needs permission', detail, [
          { kind: 'url', label: 'Open Accessibility settings', url: ax },
          { kind: 'url', label: 'Open Screen Recording settings', url: sr },
          { kind: 'retry', label: 'Check again' },
        ]),
        version: 'Codex Computer Use 26.1',
        reasonCode: 'codex.permissions',
      }),
    );
    m = await mount(createElement(NativeControlStatus, { surface: 'computer' }));
    try {
      assert.deepEqual(m.rows()[0], [
        'Codex · Computer',
        'Needs permission',
        'status-pill native-status permissions',
        'Allow Accessibility and Screen Recording for Codex Computer Use in System Settings. Codex Computer Use 26.1.',
        ['Open Accessibility settings', 'Open Screen Recording settings', 'Check again'],
      ]);
      assert.equal(m.host.querySelector('.status-pill')?.getAttribute('data-state'), 'permissions');
      // MoPilot opens the System Settings panes itself; the user turns the switches on there
      f.calls = [];
      await m.click(m.button('Open Accessibility settings'));
      await m.click(m.button('Open Screen Recording settings'));
      await m.click(m.button('Check again'));
      assert.deepEqual(f.calls, [['openExternal', ax], ['openExternal', sr], ['retry']]);
    } finally {
      await m.close();
    }
  });

  test('capability reasons are mapped across both settings surfaces; raw diagnostics and absent codes never leak', async () => {
    const raw = '/Users/private/native/helper/build/Helper.app; node scripts/build-helper.mjs';
    for (const reasonCode of ['computer.build', 'computer.screenRecording', undefined, 'constructor', ['computer.build']]) {
      const s = { state: 'unavailable', label: 'Unavailable', reasonCode, detail: raw, actions: [] };
      reset(async () => ({ ...STATUS, harnesses: [{ harness: 'claude', label: 'Claude Code', computer: s, chrome: s }] }));
      for (const surface of ['computer', 'chrome']) {
        const v = await mount(createElement(NativeControlStatus, { surface: surface as any }));
        assert.equal(v.rows()[0][3], capabilityReasonText(reasonCode));
        assert.doesNotMatch(v.host.textContent!, /private|build-helper/);
        await v.close();
      }
      f.computer = { ...computerStatus(true), health: { state: 'unavailable', reasonCode, reason: raw, usable: false, fix: null } };
      const v = await mount(createElement(ComputerUseSettings));
      assert.equal(v.host.querySelector('.cu-guide-text')!.textContent, capabilityReasonText(reasonCode));
      assert.doesNotMatch(v.host.textContent!, /private|build-helper/);
      await v.close();
    }
    reset(async () => ({
      ...STATUS,
      harnesses: [
        {
          harness: 'claude',
          label: 'Claude Code',
          computer: { state: 'permissions', label: 'Needs permission', detail: null, reasonCode: 'computer.screenRecording', actions: [] },
        },
      ],
    }));
    const known = await mount(createElement(NativeControlStatus, { surface: 'computer' }));
    assert.equal(
      known.rows()[0][3],
      capabilityReasonText('computer.screenRecording'),
      'a code does not depend on diagnostic text being present',
    );
    assert.notEqual(known.rows()[0][3], UNKNOWN_CAPABILITY_REASON);
    await known.close();
  });
  test('the computer-use engine row never displays helper paths or raw unavailable reasons', async () => {
    const raw = '/Users/private/Helper.app; node scripts/build-helper.mjs';
    for (const [running, health, expected] of [
      [true, null, 'Running'],
      [false, null, 'Starts when an agent first uses it'],
      [false, { state: 'ready' }, 'Starts when an agent first uses it'],
      [false, { state: 'unknown' }, 'Starts when an agent first uses it'],
      [false, { state: 'unavailable', reasonCode: 'computer.build', reason: raw }, capabilityReasonText('computer.build')],
      [false, { state: 'unavailable', reason: raw }, UNKNOWN_CAPABILITY_REASON],
      [false, { state: 'unavailable' }, UNKNOWN_CAPABILITY_REASON],
    ] as const) {
      reset();
      f.computer = { ...computerStatus(true), helper: { running, path: raw, version: '1' }, health };
      const v = await mount(createElement(ComputerUseSettings));
      try {
        assert.equal(v.rows().find((row: any) => row[0] === 'MoPilot Computer Use')[3], expected);
        assert.doesNotMatch(v.host.textContent!, /private|build-helper/);
      } finally {
        await v.close();
      }
    }
  });

  test('Browser settings: MoPilot’s own extension has one row for every harness it serves, with Add to Chrome and Connect', async () => {
    const ext = (state: string, label: string, reasonCode: string | undefined, actions: any[]) => ({
      ...STATUS,
      extension: { state, label, detail: 'raw /Users/private', reasonCode, actions },
    });
    const pair = { kind: 'chromePair', label: 'Connect' };
    f.native.availability.chromePair = async () => {
      f.calls.push(['chromePair']);
      return f.pairAnswer();
    };
    reset(async () => ext('permissions', 'Not installed', 'chrome.install', [{ kind: 'chromeInstall', label: 'Add to Chrome' }]));
    let m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
    try {
      assert.deepEqual(m.rows()[0], [
        'MoPilot extension',
        'Not installed',
        'status-pill native-status permissions',
        capabilityReasonText('chrome.install'),
        ['Add to Chrome'],
      ]);
      // the extension's row speaks for every harness it serves: only a vendor route in use keeps a row of its own
      assert.deepEqual(
        m.rows().map((r: any) => r[0]),
        ['MoPilot extension', ...STATUS.harnesses.filter((h: any) => h.chrome.state === 'native').map((h: any) => `${h.label} · Chrome`)],
      );
      assert.doesNotMatch(m.host.textContent!, /private/);
      // Add to Chrome: main opens the store page in Chrome; a failure is a toast
      let install: () => Promise<string> = async () => 'chrome';
      f.native.availability.chromeInstall = () => (f.calls.push(['chromeInstall']), install());
      f.calls = [];
      await m.click(m.button('Add to Chrome'));
      assert.deepEqual(f.calls, [['chromeInstall']]);
      f.calls = [];
      install = async () => Promise.reject(new Error('no Chrome'));
      await m.click(m.button('Add to Chrome'));
      assert.deepEqual(f.calls, [['chromeInstall'], ['toast', "Couldn't open the Chrome Web Store: no Chrome", 'error']]);
    } finally {
      await m.close();
    }
    // Pair: what main did reaches the user as a toast; the row itself changes when the extension connects
    reset(async () => ext('unknown', 'Not connected', 'chrome.connect', [pair]));
    m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
    try {
      assert.deepEqual(m.rows()[0].slice(1), [
        'Not connected',
        'status-pill native-status unknown',
        capabilityReasonText('chrome.connect'),
        ['Connect'],
      ]);
      for (const [answer, toast] of [
        ['opened', ['toast', 'Opened in Chrome. If MoPilot then asks, click Allow in MoPilot.', 'info']],
        ['off', ['toast', 'Turn the extension on in chrome://extensions, then try again.', 'error']],
        ['something new', ['toast', 'This build of MoPilot doesn’t use its Chrome extension.', 'error']],
      ] as const) {
        f.calls = [];
        f.pairAnswer = async () => answer;
        await m.click(m.button('Connect'));
        assert.deepEqual(f.calls, [['chromePair'], toast]);
      }
      f.calls = [];
      f.pairAnswer = async () => Promise.reject(new Error('no Chrome'));
      await m.click(m.button('Connect'));
      assert.deepEqual(f.calls, [['chromePair'], ['toast', "Couldn't open the extension's pairing page: no Chrome", 'error']]);
    } finally {
      await m.close();
    }
    // the extension asked through its host: Allow answers main's question, and a failure is a toast
    let allowAnswer: () => Promise<boolean> = async () => true;
    f.native.availability.chromeAllow = async (allow: boolean) => (f.calls.push(['chromeAllow', allow]), allowAnswer());
    reset(async () => ext('permissions', 'Waiting for your OK', 'chrome.allow', [{ kind: 'chromeAllow', label: 'Allow' }]));
    m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
    try {
      assert.deepEqual(m.rows()[0].slice(1, 4), [
        'Waiting for your OK',
        'status-pill native-status permissions',
        capabilityReasonText('chrome.allow'),
      ]);
      f.calls = [];
      await m.click(m.button('Allow'));
      assert.deepEqual(f.calls, [['chromeAllow', true]]);
      f.calls = [];
      allowAnswer = async () => Promise.reject(new Error('gone'));
      await m.click(m.button('Allow'));
      assert.deepEqual(f.calls, [
        ['chromeAllow', true],
        ['toast', "Couldn't allow Chrome: gone", 'error'],
      ]);
    } finally {
      await m.close();
    }
    // connected: a green row with nothing to do and no reason
    reset(async () => ext('mopilot', 'Connected', undefined, []));
    m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
    try {
      assert.deepEqual(m.rows()[0], ['MoPilot extension', 'Connected', 'status-pill native-status ok', '', []]);
    } finally {
      await m.close();
    }
    // the Computer use page and a status without the extension show no such row
    reset(async () => ext('mopilot', 'Connected', undefined, []));
    m = await mount(createElement(NativeControlStatus, { surface: 'computer' }));
    assert.ok(!m.rows().some((r: any) => r[0] === 'MoPilot extension'));
    await m.close();
    reset();
    m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
    assert.ok(!m.rows().some((r: any) => r[0] === 'MoPilot extension'));
    await m.close();
  });
}
