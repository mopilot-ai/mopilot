// surface decisions native availability cases using shared in-memory fixtures.
import { test, assert, codexNativeSurfaces, availabilityStatus, codexDegradedNote, LINKS, healthOf, facts, live, row } from './fixture.ts';

export function registerSurfaceDecisions() {
  /* ------------------------------------------------------- per-surface decisions */

  test('codexNativeSurfaces: each surface only where its runtime exists, and none with the switch off', () => {
    assert.deepEqual(codexNativeSurfaces(facts(), { enabled: true }), { chrome: true, computer: true });
    assert.deepEqual(codexNativeSurfaces(facts({ sky: false }), { enabled: true }), { chrome: true, computer: false });
    assert.deepEqual(codexNativeSurfaces(facts({ chrome: false }), { enabled: true }), { chrome: false, computer: true });
    assert.deepEqual(codexNativeSurfaces(facts({ runtime: false }), { enabled: true }), { chrome: false, computer: false });
    assert.deepEqual(codexNativeSurfaces(facts(), { enabled: false }), { chrome: false, computer: false });
  });

  test('status: everything installed is native for Codex and Claude Code; other harnesses use MoPilot', () => {
    const s = availabilityStatus(facts(), live({ drivesUserChrome: true }));
    assert.deepEqual(
      s.harnesses.map((h: any) => [h.harness, h.label, h.chrome.state, h.chrome.label, h.computer.state, h.computer.label]),
      [
        ['codex', 'Codex', 'native', 'Native (OpenAI extension)', 'native', 'Native (Codex Computer Use)'],
        ['claude', 'Claude Code', 'native', 'Native (Claude in Chrome)', 'mopilot', 'MoPilot computer use'],
        ['acp', 'Other harnesses', 'mopilot', 'Your Chrome', 'mopilot', 'MoPilot computer use'],
      ],
    );
    for (const h of s.harnesses)
      for (const surface of [h.chrome, h.computer])
        assert.deepEqual([surface.detail, surface.actions, surface.version ?? null], [null, [], null]);
    // only Claude in Chrome's native route shows its live extension link
    assert.deepEqual(
      s.harnesses.map((h: any) => [h.harness, !!h.chrome.linkStatus]),
      [
        ['codex', false],
        ['claude', true],
        ['acp', false],
      ],
    );
  });

  test('status: Codex without the OpenAI extension falls back to Your Chrome, or is unavailable with both fixes', () => {
    const fallback = row(availabilityStatus(facts({ chrome: false }), live({ drivesUserChrome: true })), 'codex').chrome;
    assert.deepEqual(fallback, {
      state: 'fallback',
      label: 'Fallback (Your Chrome)',
      reasonCode: 'codex.chromeMissing',
      detail: "The ChatGPT for Chrome extension isn't installed.",
      actions: [{ kind: 'url', label: 'Install ChatGPT for Chrome', url: LINKS.openaiChrome }],
    });
    const none = row(availabilityStatus(facts({ chrome: false }), live()), 'codex').chrome;
    assert.deepEqual(none, {
      state: 'unavailable',
      label: 'Unavailable',
      reasonCode: 'chrome.off',
      detail: "The ChatGPT for Chrome extension isn't installed. Your Chrome isn't selected.",
      actions: [
        { kind: 'url', label: 'Install ChatGPT for Chrome', url: LINKS.openaiChrome },
        { kind: 'yourChrome', label: 'Use Your Chrome' },
      ],
    });
  });

  test('status: off macOS the runtime is named as macOS-only; a plugin that leaves a surface out says so, with or without its version', () => {
    const win = row(availabilityStatus({ ...facts({ runtime: false }), platform: 'win32' }, live()), 'codex');
    assert.equal(win.computer.detail, "Codex's computer-use plugin runs only on macOS.");
    const f = facts({ surfaces: ['browser'] });
    const noVersion = { ...f, codex: { ...f.codex, runtime: { ...f.codex.runtime, version: null } } };
    assert.equal(
      row(availabilityStatus(noVersion, live()), 'codex').computer.detail,
      "The installed Codex plugin doesn't enable computer use.",
    );
  });

  test('status: Codex without its runtime falls back quietly: a neutral note, nothing to install or open', () => {
    const codex = row(availabilityStatus(facts({ runtime: false }), live()), 'codex');
    assert.deepEqual(codex.chrome.actions, [{ kind: 'yourChrome', label: 'Use Your Chrome' }]);
    assert.equal(codex.chrome.detail, "Codex's browser plugin isn't installed for MoPilot's Codex. Your Chrome isn't selected.");
    assert.deepEqual(codex.computer, {
      state: 'fallback',
      label: 'Fallback (MoPilot computer use)',
      reasonCode: 'native.runtime',
      detail: "Codex's computer-use plugin isn't installed for MoPilot's Codex.",
      actions: [],
      version: null,
    });
    assert.equal(LINKS.chatgpt, undefined);
  });

  test('status: Codex without Sky and without a copy to install falls back to MoPilot computer use', () => {
    const codex = row(availabilityStatus(facts({ sky: false }), live()), 'codex');
    assert.deepEqual(codex.computer, {
      state: 'fallback',
      label: 'Fallback (MoPilot computer use)',
      reasonCode: 'codex.missing',
      detail: "Codex Computer Use isn't installed, and this Mac has no copy of it to install.",
      actions: [],
      version: null,
    });
  });

  test('status: without MoPilot computer use a missing native surface is unavailable, saying why from the health record', () => {
    const ready = row(availabilityStatus(facts({ sky: false }), live({ managedComputer: false })), 'codex').computer;
    assert.deepEqual(ready, {
      state: 'unavailable',
      label: 'Unavailable',
      reasonCode: 'computer.build',
      detail:
        "Codex Computer Use isn't installed, and this Mac has no copy of it to install. MoPilot Computer Use isn't built in this checkout (/Applications/MoPilot.app/Contents/Helpers/MoPilot.app); rebuild it (node scripts/build-helper.mjs).",
      actions: [],
      version: null,
    });
    const off = availabilityStatus(facts(), live({ managedComputer: false, computerEnabled: false }));
    assert.deepEqual(row(off, 'claude').computer, {
      state: 'unavailable',
      label: 'Unavailable',
      reasonCode: 'computer.off',
      detail: "MoPilot's computer use is turned off.",
      actions: [],
    });
    assert.deepEqual(row(off, 'acp').computer, row(off, 'claude').computer);
  });

  test('status: Codex native control switched off is a fallback with the reason, and nothing to install', () => {
    const codex = row(availabilityStatus(facts(), live({ codexNative: false, drivesUserChrome: true })), 'codex');
    assert.deepEqual(codex.chrome, {
      state: 'fallback',
      label: 'Fallback (Your Chrome)',
      reasonCode: 'native.off',
      detail: "Codex's native browser control is turned off.",
      actions: [],
    });
    assert.deepEqual(codex.computer, {
      state: 'fallback',
      label: 'Fallback (MoPilot computer use)',
      reasonCode: 'native.off',
      detail: "Codex's native computer use is turned off.",
      actions: [],
      version: null,
    });
  });

  test('status: Claude in Chrome needs the switch, the extension and a subscription login, in that order', () => {
    const chrome = (f: any, l: any) => row(availabilityStatus(f, live({ drivesUserChrome: true, ...l })), 'claude').chrome;
    assert.deepEqual(chrome(facts(), { claudeFlag: false, claudeEligible: false }), {
      state: 'fallback',
      label: 'Fallback (Your Chrome)',
      reasonCode: 'native.off',
      detail: 'Claude in Chrome is turned off.',
      actions: [],
    });
    assert.deepEqual(chrome(facts({ claude: false }), { claudeEligible: false }), {
      state: 'fallback',
      label: 'Fallback (Your Chrome)',
      reasonCode: 'claude.chromeMissing',
      detail: "The Claude in Chrome extension isn't installed.",
      actions: [{ kind: 'url', label: 'Install Claude in Chrome', url: LINKS.claudeChrome }],
    });
    assert.deepEqual(chrome(facts(), { claudeEligible: false }), {
      state: 'fallback',
      label: 'Fallback (Your Chrome)',
      reasonCode: 'claude.subscription',
      detail: 'Claude in Chrome needs a claude.ai subscription login.',
      actions: [],
    });
    // without Your Chrome either: unavailable, with the way to Your Chrome
    const none = row(availabilityStatus(facts(), live({ claudeEligible: false })), 'claude').chrome;
    assert.deepEqual(none, {
      state: 'unavailable',
      label: 'Unavailable',
      reasonCode: 'chrome.off',
      detail: "Claude in Chrome needs a claude.ai subscription login. Your Chrome isn't selected.",
      actions: [{ kind: 'yourChrome', label: 'Use Your Chrome' }],
    });
    // other harnesses without Your Chrome: only the way to it
    assert.deepEqual(row(availabilityStatus(facts(), live()), 'acp').chrome, {
      state: 'unavailable',
      label: 'Unavailable',
      reasonCode: 'chrome.off',
      detail: "Your Chrome isn't selected.",
      actions: [{ kind: 'yourChrome', label: 'Use Your Chrome' }],
    });
  });

  /* -------------------------------------------------------------- the model note */

  test("codexDegradedNote: names MoPilot's tool for the missing surface, or the setup to tell the user", () => {
    const o = { serverName: 'sage_x', health: healthOf({ yourChrome: true }) };
    const none = { serverName: 'sage_x', health: healthOf({ computer: 'off' }) };
    assert.equal(codexDegradedNote(facts(), { chrome: true, computer: true }, o), null);
    const computer = codexDegradedNote(facts({ sky: false }), { chrome: true, computer: false }, o);
    assert.equal(
      computer,
      "MoPilot native control: Computer use through the Computer plugin is unavailable here (Codex Computer Use isn't installed, and this Mac has no copy of it to install.); use the desktop_* tools of the sage_x MCP server to control apps.",
    );
    const chrome = codexDegradedNote(facts({ chrome: false }), { chrome: false, computer: true }, o);
    assert.equal(
      chrome,
      "MoPilot native control: The Browser plugin cannot reach the user's Chrome here (The ChatGPT for Chrome extension isn't installed.); use the sage_browser_* tools of the sage_x MCP server for the user's Chrome.",
    );
    const neither = codexDegradedNote(facts({ sky: false, chrome: false }), { chrome: false, computer: false }, none);
    assert.match(
      neither,
      /MoPilot's computer use can't be used either \(MoPilot's computer use is turned off\.\) If a task needs computer use, say it is unavailable\. Do not work around it\./,
    );
    assert.doesNotMatch(neither, /ChatGPT app|Open ChatGPT/);
    // a failed install names MoPilot's own Try again
    assert.match(
      codexDegradedNote(facts({ sky: false }), { chrome: true, computer: false }, none, {
        install: { phase: 'failed', action: 'install', version: '2', error: 'e' },
      }),
      /couldn't install Codex Computer Use 2: e\), and MoPilot's computer use can't be used either \(MoPilot's computer use is turned off\.\) If a task needs computer use, say it is unavailable and that the user can fix it with "Try again" in MoPilot's Computer use settings\./,
    );
    assert.match(
      neither,
      /If a task needs the user's Chrome, say it is unavailable and that the user can install ChatGPT for Chrome or choose Your Chrome in MoPilot's Browser settings\. Do not work around it\.$/,
    );
    // without the runtime, the Chrome note names only Your Chrome
    assert.match(
      codexDegradedNote(facts({ runtime: false }), { chrome: false, computer: true }, none),
      /\(Codex's browser plugin isn't installed for MoPilot's Codex\.\), and Your Chrome can't be used either \(Your Chrome isn't selected\.\) If a task needs the user's Chrome, say it is unavailable and that the user can choose Your Chrome in MoPilot's Browser settings\. Do not work around it\.$/,
    );
    // set up after the thread was loaded: the thread keeps its surfaces until it is loaded again
    assert.match(codexDegradedNote(facts(), { chrome: false, computer: false }, o), /\(it was not set up when this chat was loaded\)/);
  });
}
