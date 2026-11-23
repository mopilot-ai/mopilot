// probe native availability cases using shared in-memory fixtures.
import {
  test,
  assert,
  probeNativeAvailability,
  SKY_BUNDLE_ID,
  vendorChromeProfile,
  HOME,
  APP,
  RES,
  CACHE,
  CACHE_MCP,
  mcpJson,
  prefs,
  SKY,
  CHROME,
  HOSTS,
  OPENAI_EXT,
  CLAUDE_EXT,
  hostManifest,
  fakeFs,
  fullMac,
  RUNTIME,
  probe,
  without,
} from './fixture.ts';

export function registerProbe() {
  test('probe: a Mac with the materialized plugin, Sky and both extensions has every native piece', () => {
    assert.deepEqual(probe(fullMac()), {
      platform: 'darwin',
      codex: {
        runtime: RUNTIME,
        sky: { present: true, path: SKY, version: null, bundled: null, source: null, canonical: SKY },
        chrome: { host: true, extension: true, enabled: true, ready: true },
      },
      claude: { chrome: { host: true, extension: true, enabled: true, ready: true } },
    });
  });

  test('probe: the plugins cache counts only when its cua_repl command exists; the newest version by number wins', () => {
    const base = without(fullMac(), APP, CACHE);
    const cached = {
      ...base,
      [`${CACHE}/1.0/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/1.0/.mcp.json`]: JSON.stringify({ mcpServers: { cua_repl: { command: '/opt/node' } } }),
    };
    assert.deepEqual(probe(cached).codex.runtime, {
      present: false,
      source: null,
      version: null,
      app: null,
      surfaces: null,
      backends: null,
    });
    // the newest version whose command exists wins: 1.10 is newer than 1.9 (not by text), and `latest` is no version
    const withNode = {
      ...cached,
      '/opt/node': '',
      [`${CACHE}/0.9/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/1.9/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/1.9/.mcp.json`]: JSON.stringify({ mcpServers: { cua_repl: { command: '/opt/node' } } }),
      [`${CACHE}/1.10/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/1.10/.mcp.json`]: JSON.stringify({
        mcpServers: {
          cua_repl: { command: '/opt/node', env: { CUA_REPL_ENABLED_SURFACES: 'browser', BROWSER_USE_AVAILABLE_BACKENDS: 'iab, chrome' } },
        },
      }),
      [`${CACHE}/latest/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/latest/.mcp.json`]: JSON.stringify({ mcpServers: { cua_repl: { command: '/opt/node' } } }),
    };
    assert.deepEqual(probe(withNode).codex.runtime, {
      present: true,
      source: 'plugins-cache',
      version: '1.10',
      app: null,
      surfaces: ['browser'],
      backends: ['iab', 'chrome'],
    });
    // a cache entry without .mcp.json, or with a cua_repl command that isn't text, does not count
    assert.equal(probe({ ...base, [`${CACHE}/2.0/.codex-plugin/plugin.json`]: '{}' }).codex.runtime.present, false);
    assert.equal(
      probe({
        ...base,
        [`${CACHE}/2.0/.codex-plugin/plugin.json`]: '{}',
        [`${CACHE}/2.0/.mcp.json`]: JSON.stringify({ mcpServers: { cua_repl: { command: 7 } } }),
      }).codex.runtime.present,
      false,
    );
    // Sky is still found in its usual place without the plugin's .mcp.json
    assert.deepEqual(probe(withNode).codex.sky, { present: true, path: SKY, version: null, bundled: null, source: null, canonical: SKY });
  });

  test('probe: ChatGPT.app is no runtime by itself: Codex loads the plugin its home materialized (the app is still named)', () => {
    const absent = { present: false, source: null, version: null, surfaces: null, backends: null };
    // the app bundles the plugin, but this Codex home never materialized it
    assert.deepEqual(probe(without(fullMac(), CACHE)).codex.runtime, { ...absent, app: APP });
    // the materialized plugin's node is gone with the app's cua_node
    assert.deepEqual(probe(without(fullMac(), `${RES}/cua_node`)).codex.runtime, { ...absent, app: APP });
    // ~/Applications is looked at too
    const userApp = Object.fromEntries(
      Object.entries(without(fullMac(), CACHE)).map(([k, v]) => [k.startsWith(APP) ? `${HOME}${k}` : k, v]),
    );
    assert.deepEqual(probe(userApp).codex.runtime, { ...absent, app: `${HOME}${APP}` });
  });

  test('probe: Sky needs its bundle id; the path the plugin names comes first', () => {
    const other = '/Elsewhere/Sky.app';
    const files = {
      ...without(fullMac(), SKY),
      [CACHE_MCP]: mcpJson({ SKY_CUA_SERVICE_PATH: other }),
      [`${other}/Contents/Info.plist`]: SKY_BUNDLE_ID,
    };
    assert.deepEqual(probe(files).codex.sky, { present: true, path: other, version: null, bundled: null, source: null, canonical: SKY });
    assert.deepEqual(probe({ ...without(fullMac(), SKY), [`${SKY}/Contents/Info.plist`]: 'com.example.other' }).codex.sky, {
      present: false,
      path: null,
      version: null,
      bundled: null,
      source: null,
      canonical: SKY,
    });
    // no Sky anywhere
    assert.deepEqual(probe(without(fullMac(), SKY)).codex.sky, {
      present: false,
      path: null,
      version: null,
      bundled: null,
      source: null,
      canonical: SKY,
    });
    // a non-text path in the plugin's env is ignored
    const odd = {
      ...fullMac(),
      [CACHE_MCP]: mcpJson({ SKY_CUA_SERVICE_PATH: 3 }),
    };
    assert.deepEqual(probe(odd).codex.sky, { present: true, path: SKY, version: null, bundled: null, source: null, canonical: SKY });
  });

  test('probe: a Chrome host needs its manifest, its program, and an allowed extension in a profile', () => {
    const full = fullMac();
    const none = { host: false, extension: false, enabled: false, ready: false };
    // no manifest
    assert.deepEqual(probe(without(full, `${HOSTS}/com.openai`)).codex.chrome, none);
    // manifest whose program is gone
    assert.deepEqual(probe(without(full, '/bin/openai-host')).codex.chrome, none);
    // manifest without the extension installed
    assert.deepEqual(probe(without(full, `${CHROME}/Default/Extensions/${OPENAI_EXT}`)).codex.chrome, {
      host: true,
      extension: false,
      enabled: false,
      ready: false,
    });
    // allowed_origins that isn't a list, or names no extension id
    assert.equal(
      probe({ ...full, [`${HOSTS}/com.openai.codexextension.json`]: hostManifest('/bin/openai-host', 'x') }).codex.chrome.ready,
      false,
    );
    assert.equal(
      probe({ ...full, [`${HOSTS}/com.openai.codexextension.json`]: hostManifest('/bin/openai-host', ['https://example.com/']) }).codex
        .chrome.ready,
      false,
    );
    // Claude Desktop's host counts for Claude in Chrome too; a profile folder that isn't a profile does not
    const desktop = {
      ...without(full, `${HOSTS}/com.anthropic`, `${CHROME}/Profile 2`),
      [`${HOSTS}/com.anthropic.claude_browser_extension.json`]: hostManifest('/bin/claude-host', [`chrome-extension://${CLAUDE_EXT}/`]),
      [`${CHROME}/System Profile/Extensions/${CLAUDE_EXT}/1/m.json`]: '{}',
    };
    assert.deepEqual(probe(desktop).claude.chrome, { host: true, extension: false, enabled: false, ready: false });
    assert.deepEqual(
      probe({
        ...desktop,
        [`${CHROME}/Profile 7/Extensions/${CLAUDE_EXT}/1/m.json`]: '{}',
        [`${CHROME}/Profile 7/Preferences`]: prefs(CLAUDE_EXT),
      }).claude.chrome,
      { host: true, extension: true, enabled: true, ready: true },
    );
    // a file system that refuses to answer reads as missing
    assert.equal(probe(full, { throwOn: '/bin/claude-host' }).claude.chrome.ready, false);
  });

  test('probe: off macOS every native piece reads as missing', () => {
    const none = { host: false, extension: false, enabled: false, ready: false };
    assert.deepEqual(probeNativeAvailability({ platform: 'win32', fs: fakeFs(fullMac()) }), {
      platform: 'win32',
      codex: {
        runtime: { present: false, source: null, version: null, app: null, surfaces: null, backends: null },
        sky: { present: false, path: null, version: null, bundled: null, source: null, canonical: null },
        chrome: none,
      },
      claude: { chrome: none },
    });
    // the defaults read this machine without throwing
    assert.equal(typeof probeNativeAvailability().platform, 'string');
  });
}

export function registerVendorProfiles() {
  test('vendorChromeProfile: the browser and profile each vendor controller of Chrome is on, Google Chrome first', () => {
    const at = (files: Record<string, string>, controller: string, dirs: string[] = []) =>
      vendorChromeProfile(controller, { fs: fakeFs(files, dirs), home: HOME, platform: 'darwin' });
    // the Codex extension is on in Chrome's Default profile, Claude in Chrome in Profile 2
    assert.deepEqual(at(fullMac(), 'codex-browser-plugin'), { browser: 'chrome', name: 'Google Chrome', profile: 'Default' });
    assert.deepEqual(at(fullMac(), 'claude-in-chrome'), { browser: 'chrome', name: 'Google Chrome', profile: 'Profile 2' });
    // turned off in Chrome: Brave, where it is on, is the one it is paired with
    const BRAVE = `${HOME}/Library/Application Support/BraveSoftware/Brave-Browser`;
    const braveOnly = {
      ...fullMac(),
      [`${CHROME}/Profile 2/Secure Preferences`]: prefs(CLAUDE_EXT, { state: 0 }),
      [`${BRAVE}/NativeMessagingHosts/com.anthropic.claude_browser_extension.json`]: hostManifest('/bin/claude-host', [
        `chrome-extension://${CLAUDE_EXT}/`,
      ]),
      [`${BRAVE}/Profile 1/Extensions/${CLAUDE_EXT}/1.0/manifest.json`]: '{}',
      [`${BRAVE}/Profile 1/Preferences`]: prefs(CLAUDE_EXT),
    };
    assert.deepEqual(at(braveOnly, 'claude-in-chrome'), { browser: 'brave', name: 'Brave', profile: 'Profile 1' });
    // not on this Mac: none
    assert.equal(at(without(fullMac(), HOSTS), 'codex-browser-plugin'), null);
    assert.equal(vendorChromeProfile('claude-in-chrome', { fs: fakeFs({}), home: HOME, platform: 'linux' }), null);
    // main's call: this machine's own browsers, read only
    const here = vendorChromeProfile('claude-in-chrome');
    assert.ok(here === null || typeof here.profile === 'string');
  });
}
