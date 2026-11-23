// Shared in-memory runtime installations, availability facts, and real services for native availability unit cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  probeNativeAvailability,
  codexNativeSurfaces,
  availabilityStatus,
  codexDegradedNote,
  NativeAvailability,
  SKY_BUNDLE_ID,
  LINKS,
  vendorChromeProfile,
} = require('../../../electron/capabilities/nativeAvailability.cjs');
const { ToolVisibility, isToolHidden } = require('../../../electron/capabilities/visibility.cjs');
const {
  CodexToolInjection,
  IN_APP_BROWSER_CONTEXT,
  inAppBrowserNote,
  scopeNote,
  NATIVE_CUA_PLUGIN,
} = require('../../../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../../../electron/capabilities/contract/session.cjs');
const { chromeSelectionNote } = require('../../../electron/capabilities/browser/codexChromePick.cjs');
import { healthOf } from '../control-matrix-kit.ts';

/* ---------------------------------------------------------------- the probe */

const HOME = '/Users/u';
const APP = '/Applications/ChatGPT.app';
const RES = `${APP}/Contents/Resources`;
const APP_PLUGIN = `${RES}/plugins/openai-bundled/plugins/unified-computer-use`;
const CACHE = `${HOME}/.codex/plugins/cache/openai-bundled/unified-computer-use`;
/** The plugin copy Codex materialized in its home: what a thread really loads. */
const CACHE_V = `${CACHE}/26.1007.1`;
const CACHE_MCP = `${CACHE_V}/.mcp.json`;
const NODE = `${RES}/cua_node/bin/node`;
/** The plugin's .mcp.json, as the ChatGPT app materializes it: cua_repl on the app's node, with its env. */
const mcpJson = (env: Record<string, unknown> = {}, command: unknown = NODE) =>
  JSON.stringify({
    mcpServers: { cua_repl: { command, env: { NODE_REPL_NODE_MODULE_DIRS: `${RES}/cua_node/lib/node_modules`, ...env } } },
  });
/** Chrome's record of an extension in a profile's Preferences (state 1: on). */
const prefs = (id: string, entry: Record<string, unknown> = { state: 1 }) => JSON.stringify({ extensions: { settings: { [id]: entry } } });
const SKY = `${HOME}/.codex/computer-use/Codex Computer Use.app`;
const CHROME = `${HOME}/Library/Application Support/Google/Chrome`;
const HOSTS = `${CHROME}/NativeMessagingHosts`;
const OPENAI_EXT = 'hehggadaopoacecdllhhajmbjkdcmajg';
const CLAUDE_EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const hostManifest = (bin: string, ids: unknown) => JSON.stringify({ path: bin, allowed_origins: ids });

/** An in-memory file system: files with contents, and directories implied by their paths (or listed). */
function fakeFs(files: Record<string, string>, extraDirs: string[] = [], opts: { throwOn?: string } = {}) {
  const dirs = new Set<string>(extraDirs);
  for (const p of [...Object.keys(files), ...extraDirs]) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') || '/');
  }
  return {
    existsSync: (p: string) => {
      if (opts.throwOn && p.includes(opts.throwOn)) throw new Error('EACCES');
      return p in files || dirs.has(p);
    },
    readFileSync: (p: string) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    readdirSync: (p: string) => {
      if (!dirs.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const prefix = p.endsWith('/') ? p : `${p}/`;
      return [
        ...new Set([...Object.keys(files), ...dirs].filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length).split('/')[0])),
      ];
    },
  };
}

/** A Mac with everything: the plugin materialized in the Codex home, ChatGPT.app's node, Sky, both extensions (on) and their hosts. */
function fullMac(): Record<string, string> {
  return {
    [`${APP_PLUGIN}/.codex-plugin/plugin.json`]: '{}',
    [`${CACHE_V}/.codex-plugin/plugin.json`]: '{}',
    [CACHE_MCP]: mcpJson({ SKY_CUA_SERVICE_PATH: SKY }),
    [NODE]: '',
    [`${SKY}/Contents/Info.plist`]: `<key>CFBundleIdentifier</key><string>${SKY_BUNDLE_ID}</string>`,
    [`${HOSTS}/com.openai.codexextension.json`]: hostManifest('/bin/openai-host', [`chrome-extension://${OPENAI_EXT}/`]),
    '/bin/openai-host': '',
    [`${CHROME}/Default/Extensions/${OPENAI_EXT}/1.0/manifest.json`]: '{}',
    [`${CHROME}/Default/Preferences`]: prefs(OPENAI_EXT),
    [`${HOSTS}/com.anthropic.claude_code_browser_extension.json`]: hostManifest('/bin/claude-host', [`chrome-extension://${CLAUDE_EXT}/`]),
    '/bin/claude-host': '',
    [`${CHROME}/Profile 2/Extensions/${CLAUDE_EXT}/1.0/manifest.json`]: '{}',
    [`${CHROME}/Profile 2/Secure Preferences`]: prefs(CLAUDE_EXT),
  };
}
const RUNTIME = { present: true, source: 'plugins-cache', version: '26.1007.1', app: null, surfaces: null, backends: null };
const probe = (files: Record<string, string>, o: any = {}) =>
  probeNativeAvailability({
    fs: fakeFs(files, o.dirs, o),
    home: HOME,
    platform: 'darwin',
    appDirs: ['/Applications', `${HOME}/Applications`],
    ...o.extra,
  });
const without = (files: Record<string, string>, ...prefixes: string[]) =>
  Object.fromEntries(Object.entries(files).filter(([k]) => !prefixes.some((p) => k.startsWith(p))));

const SKY_RES = `${RES}/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app`;

/** An XML Info.plist as Sky ships it: its bundle id and its version. */
const skyPlist = (version: string | null, id = SKY_BUNDLE_ID) =>
  `<?xml version="1.0"?><plist version="1.0"><dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>${id}</string>${version == null ? '' : `\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>`}\n</dict></plist>`;

const skyFacts = (version: string | null, bundled: string | null, app: string | null = APP) => {
  const f = facts({ app });
  return { ...f, codex: { ...f.codex, sky: { present: true, path: SKY, version, bundled } } };
};

const REPORT = {
  message: 'Sky Computer Use API version mismatch: client=CodexComputerUseIPC-5 server=CodexComputerUseIPC-6',
  version: '26.1005.1',
};

const facts = (
  o: {
    runtime?: boolean;
    sky?: boolean;
    chrome?: boolean;
    claude?: boolean;
    app?: string | null;
    surfaces?: string[] | null;
    backends?: string[] | null;
  } = {},
) => ({
  platform: 'darwin',
  codex: {
    runtime: {
      present: o.runtime ?? true,
      source: 'plugins-cache',
      version: '26.1007.1',
      app: o.app === undefined ? APP : o.app,
      surfaces: o.surfaces ?? null,
      backends: o.backends ?? null,
    },
    sky: { present: o.sky ?? true, path: SKY },
    chrome: { host: true, extension: o.chrome ?? true, ready: o.chrome ?? true },
  },
  claude: { chrome: { host: true, extension: o.claude ?? true, ready: o.claude ?? true } },
});

/** The status's live facts; MoPilot's own surfaces through the capability health record (healthOf). */
const live = ({ drivesUserChrome = false, managedComputer = true, computerEnabled = true, health, ...o }: any = {}) => ({
  codexNative: true,
  claudeFlag: true,
  claudeEligible: true,
  health: health ?? healthOf({ yourChrome: drivesUserChrome, computer: !computerEnabled ? 'off' : managedComputer ? 'ready' : 'missing' }),
  ...o,
});

const row = (status: any, harness: string) => status.harnesses.find((h: any) => h.harness === harness);

export {
  test,
  assert,
  NativeAvailability,
  RES,
  CACHE,
  mcpJson,
  SKY,
  fullMac,
  probe,
  without,
  skyPlist,
  facts,
  live,
  row,
  probeNativeAvailability,
  SKY_BUNDLE_ID,
  vendorChromeProfile,
  HOME,
  APP,
  CACHE_MCP,
  prefs,
  CHROME,
  HOSTS,
  OPENAI_EXT,
  CLAUDE_EXT,
  hostManifest,
  fakeFs,
  RUNTIME,
  codexNativeSurfaces,
  availabilityStatus,
  SKY_RES,
  skyFacts,
  REPORT,
  codexDegradedNote,
  LINKS,
  healthOf,
  ToolVisibility,
  isToolHidden,
  CodexToolInjection,
  IN_APP_BROWSER_CONTEXT,
  inAppBrowserNote,
  scopeNote,
  NATIVE_CUA_PLUGIN,
  ToolSessions,
  chromeSelectionNote,
};
