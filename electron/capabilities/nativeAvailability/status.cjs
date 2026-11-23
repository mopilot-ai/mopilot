// Per-harness native/fallback status descriptions and model-facing degraded-control notes.
const { PRIVACY_PANES } = require('../../../shared/skyComputerUse.mjs');
const { staleGrantHint } = require('../../../shared/staleGrant.mjs');
const { pluginEnables } = require('./probe.cjs');
const { codexChromeRoute } = require('../browser/chromeControl.cjs');
const { extensionStatus } = require('./extensionStatus.cjs');

const LINKS = {
  openaiChrome: 'https://chromewebstore.google.com/detail/hehggadaopoacecdllhhajmbjkdcmajg',
  claudeChrome: 'https://claude.ai/chrome',
};
/**
 * What MoPilot knows about Codex Computer Use besides the probe.
 * @typedef {{ skyReport?: { message: string, version: string | null } | null,
 *             install?: { phase: 'running' | 'failed' | 'waiting', action: string, version: string, error: string | null } | null,
 *             permissions?: { kind: string } | null, skyDown?: { message: string, at: number } | null, nativeComputer?: boolean }} SkyState
 *   skyReport: a version mismatch Codex Computer Use reported (with the version installed then); install:
 *   MoPilot's install or update of it, while it runs or after it failed; permissions: a missing
 *   permission it reported; skyDown: its service didn't start in a chat, recently
 */

/**
 * Whether Codex Computer Use reported a version the plugin doesn't support (`report`, kept until a different
 * version is installed) for the copy installed now.
 */
const skyBroken = (facts, /** @type {SkyState['skyReport']} */ report) => !!report && report.version === facts.codex.sky.version;

/**
 * The surfaces a Codex thread loaded now gets from the vendor plugin: each only where its runtime exists, and computer
 * use only while the installed Codex Computer Use works with the plugin, for someone who chose it (codexNativeComputer).
 * @param {{ enabled: boolean, codexNativeComputer?: boolean, skyReport?: SkyState['skyReport'], skyDown?: boolean, chromeServed?: ChromeServed, codexChromeBackend?: boolean }} o
 * @returns {{ chrome: boolean, computer: boolean, chromeRoute?: 'vendor' | 'tools' | 'backend' }}
 */
function codexNativeSurfaces(facts, o) {
  const runtime = facts.codex.runtime;
  const route = codexChromeRoute(o.chromeServed);
  const provenance = o.chromeServed ? { chromeRoute: route } : {};
  if (!o.enabled || !runtime.present) return { chrome: false, computer: false, ...provenance };
  const sky = o.codexNativeComputer !== false && facts.codex.sky.present && !skyBroken(facts, o.skyReport) && !o.skyDown;
  return {
    ...provenance,
    chrome: pluginEnables(runtime, 'browser') && (route === 'backend' ? o.codexChromeBackend === true : facts.codex.chrome.ready),
    computer: pluginEnables(runtime, 'computer') && sky,
  };
}

/** Codex's runtime missing: a neutral note; the user isn't sent to install or open another app. */
const noRuntime = (what, platform) => ({
  reasonCode: platform === 'darwin' ? 'native.runtime' : 'native.platform',
  reason:
    platform === 'darwin' ? `Codex's ${what} plugin isn't installed for MoPilot's Codex.` : `Codex's ${what} plugin runs only on macOS.`,
  setup: null,
});
/** The installed plugin leaves a surface out (its CUA_REPL_ENABLED_SURFACES or browser backends). */
const notEnabled = (facts, what) => ({
  reasonCode: 'native.surface',
  reason: `The installed Codex plugin${facts.codex.runtime.version ? ` (${facts.codex.runtime.version})` : ''} doesn't enable ${what}.`,
  setup: null,
});
const TRY_AGAIN = { kind: 'retry', label: 'Try again' };
const skyName = (version) => (version ? `Codex Computer Use ${version}` : 'Codex Computer Use');

/** Why the selected Chrome route is not used, and how to get it; null when it is.
 * @param {any} facts @param {boolean} enabled
 * @param {{ route: 'vendor' | 'tools' | 'backend', backend?: boolean, health: Health }} o
 */
function codexChromeGap(facts, enabled, { route, backend, health }) {
  if (!enabled) return { reasonCode: 'native.off', reason: "Codex's native browser control is turned off.", setup: null };
  if (route === 'tools') return null;
  if (!facts.codex.runtime.present) return noRuntime('browser', facts.platform);
  if (!pluginEnables(facts.codex.runtime, 'browser')) return notEnabled(facts, "the user's Chrome");
  if (route === 'backend') {
    if (backend) return null;
    const own = health.chromeRelay;
    return own && !own.usable && own.reason
      ? { reasonCode: own.reasonCode, reason: own.reason, setup: own.fix }
      : {
          reasonCode: 'codex.chromeBackend',
          reason: "MoPilot's Chrome backend isn't available; reload the chat, or restart MoPilot if it stays unavailable.",
          setup: null,
        };
  }
  if (facts.codex.chrome.extension && !facts.codex.chrome.ready)
    return {
      reasonCode: 'codex.chromeDisabled',
      reason: 'The ChatGPT for Chrome extension is turned off in Chrome; turn it on in Chrome → Extensions.',
      setup: null,
    };
  if (!facts.codex.chrome.ready)
    return {
      reasonCode: 'codex.chromeMissing',
      reason: "The ChatGPT for Chrome extension isn't installed.",
      setup: { kind: 'url', label: 'Install ChatGPT for Chrome', url: LINKS.openaiChrome },
    };
  return null;
}

/**
 * Why Codex's native computer use is not used, and what fixes it; null when it is.
 * @param {SkyState} sky
 */
function codexComputerGap(facts, enabled, sky) {
  const { install, skyReport } = sky;
  if (!enabled) return { reasonCode: 'native.off', reason: "Codex's native computer use is turned off.", setup: null };
  if (sky.nativeComputer === false) return { reasonCode: 'native.choice', reason: 'Codex Computer Use is off in Settings.', setup: null };
  if (!facts.codex.runtime.present) return noRuntime('computer-use', facts.platform);
  if (!pluginEnables(facts.codex.runtime, 'computer')) return notEnabled(facts, 'computer use');
  const { present, version } = facts.codex.sky;
  const broken = skyBroken(facts, skyReport);
  const blocked = !present || broken;
  const updating = install?.action === 'update';
  if (blocked && install?.phase === 'running')
    return {
      reasonCode: 'codex.installing',
      reason: `MoPilot is ${updating ? 'updating' : 'installing'} ${skyName(install.version)}.`,
      setup: null,
    };
  if (blocked && install?.phase === 'failed')
    return {
      reasonCode: 'codex.installFailed',
      reason: `MoPilot couldn't ${updating ? 'update' : 'install'} ${skyName(install.version)}: ${install.error}`,
      setup: TRY_AGAIN,
    };
  if (!present)
    return {
      reasonCode: 'codex.missing',
      reason: "Codex Computer Use isn't installed, and this Mac has no copy of it to install.",
      setup: null,
    };
  if (sky.skyDown)
    return {
      reasonCode: 'codex.unavailable',
      reason: "Codex Computer Use didn't start, so chats use MoPilot's computer use for now.",
      setup: TRY_AGAIN,
    };
  if (skyReport && broken)
    return {
      reasonCode: 'codex.incompatible',
      reason: `${skyName(version)} reported a version the Codex plugin doesn't support (“${skyReport.message}”), and this Mac has no newer copy. New chats use MoPilot's computer use instead.`,
      setup: null,
    };
  return null;
}

/** Why Claude in Chrome is not used, and how to get it; null when it is. */
function claudeChromeGap(facts, { flag, eligible }) {
  if (eligible) return null;
  if (!flag) return { reasonCode: 'native.off', reason: 'Claude in Chrome is turned off.', setup: null };
  if (facts.claude.chrome.extension && !facts.claude.chrome.ready)
    return {
      reasonCode: 'claude.chromeDisabled',
      reason: 'The Claude in Chrome extension is turned off in Chrome; turn it on in Chrome → Extensions.',
      setup: null,
    };
  if (!facts.claude.chrome.ready)
    return {
      reasonCode: 'claude.chromeMissing',
      reason: "The Claude in Chrome extension isn't installed.",
      setup: { kind: 'url', label: 'Install Claude in Chrome', url: LINKS.claudeChrome },
    };
  return { reasonCode: 'claude.subscription', reason: 'Claude in Chrome needs a claude.ai subscription login.', setup: null };
}

const YOUR_CHROME = { kind: 'yourChrome', label: 'Use Your Chrome' };

/**
 * The capability health record (capabilityHealth.cjs) a status row or note reads for MoPilot's own
 * surfaces: computer use on its helper, Your Chrome, and whether each harness family gets the tools at all.
 * @typedef {{ computer: import('../capabilityHealth.cjs').SurfaceHealth, yourChrome: import('../capabilityHealth.cjs').SurfaceHealth,
 *             chromeRelay?: import('../capabilityHealth.cjs').SurfaceHealth & { channel?: string },
 *             channels: { claude: boolean, codex: boolean, acp: boolean } }} Health
 *   chromeRelay: MoPilot's own channel to the user's Chrome (its extension, or the relay), where main runs it
 */

/**
 * Which sessions MoPilot's own channel serves the user's Chrome to (chromeControl.cjs servedChrome).
 * @typedef {{ tools: boolean, codex: boolean, takeover?: boolean, kind: 'extension' | 'relay' | null }} ChromeServed
 */
const NOT_SERVED = /** @type {ChromeServed} */ ({ tools: false, codex: false, takeover: false, kind: null });
/** What a row names MoPilot's own channel. */
const OWN_CHROME = { extension: "MoPilot's extension", relay: "MoPilot's Chrome relay" };

/** Why a harness family gets none of MoPilot's tools. */
const NO_CHANNEL = {
  claude: "MoPilot's tools are turned off for Claude Code sessions.",
  codex: "MoPilot's tools are turned off for Codex threads.",
  acp: "MoPilot's tools are turned off for these harnesses.",
};
const unavailable = (detail, actions, reasonCode) => ({ state: 'unavailable', label: 'Unavailable', detail, actions, reasonCode });
/** What a usable MoPilot surface that still needs something is shown as. */
const SETUP_STATE = { permission: 'permissions', error: 'unavailable', unknown: 'unknown' };

/**
 * A Chrome surface without the native path. Your Chrome when it is chosen (its sage_browser_* replace the chrome_*
 * tools then). Otherwise MoPilot's own channel (`served`: its chrome_* tools or backend reach this harness's
 * sessions), as the health record has it: paired, connected, or what is missing (#1631: never "Use Your Chrome" here,
 * which would hide the chrome_* tools that serve the session). Only where neither serves it, why not and the way to
 * Your Chrome.
 * @param {{ reason: string, setup: any, reasonCode?: string } | null} gap why the native path isn't used
 * @param {{ health: Health, harness: 'claude' | 'codex' | 'acp', served?: boolean, kind?: ChromeServed['kind'] }} o
 */
function chromeFallback(gap, { health, harness, served = false, kind = null }, nativeExpected) {
  const actions = gap?.setup ? [gap.setup] : [];
  const why = gap?.reason ? `${gap.reason} ` : '';
  const yc = health.yourChrome;
  const own = yc.state === 'off' && served && kind ? health.chromeRelay : null;
  if (own) return ownChromeFallback(gap, own, { health, harness, label: OWN_CHROME[kind] }, nativeExpected);
  if (yc.state === 'off') return unavailable(`${why}Your Chrome isn't selected.`, [...actions, YOUR_CHROME], 'chrome.off');
  if (!health.channels[harness]) return unavailable(`${why}${NO_CHANNEL[harness]}`, actions, 'tools.off');
  const fix = yc.fix ? [yc.fix] : [];
  if (!yc.usable) return unavailable(`${why}${yc.reason}`, [...actions, ...fix], yc.reasonCode);
  const label = nativeExpected ? 'Fallback (Your Chrome)' : 'Your Chrome';
  if (yc.state !== 'ready')
    return {
      state: 'permissions',
      label: 'Needs setup',
      detail: `${why}${yc.reason}`,
      reasonCode: yc.reasonCode,
      actions: [...actions, ...fix],
    };
  return { state: nativeExpected ? 'fallback' : 'mopilot', label, detail: gap?.reason ?? null, reasonCode: gap?.reasonCode, actions };
}

/**
 * MoPilot's own channel as a Chrome surface's route: green only when its extension is paired and connected;
 * not paired yet is setup (the first browser step opens the pairing page), not connected is unknown until Chrome
 * opens, and a channel that can't work says why.
 * @param {{ reason: string, setup: any, reasonCode?: string } | null} gap
 * @param {import('../capabilityHealth.cjs').SurfaceHealth & { channel?: string }} c the health record's chromeRelay
 * @param {{ health: Health, harness: 'claude' | 'codex' | 'acp', label: string, needsChannel?: boolean }} o
 */
function ownChromeFallback(gap, c, { health, harness, label, needsChannel = true }, nativeExpected) {
  const actions = gap?.setup ? [gap.setup] : [];
  const why = gap?.reason ? `${gap.reason} ` : '';
  if (needsChannel && !health.channels[harness]) return unavailable(`${why}${NO_CHANNEL[harness]}`, actions, 'tools.off');
  // MoPilot's own extension carries its install link and Pair on its one row (extensionStatus), not on each harness's
  const fix = c.fix && c.channel !== 'extension' ? [c.fix] : [];
  if (!c.usable) return unavailable(`${why}${c.reason}`, [...actions, ...fix], c.reasonCode);
  const named = nativeExpected ? `Fallback (${label})` : label;
  if (c.state === 'ready')
    return {
      state: nativeExpected ? 'fallback' : 'mopilot',
      label: named,
      detail: gap?.reason ?? null,
      reasonCode: gap?.reasonCode,
      actions,
    };
  return {
    state: SETUP_STATE[c.state],
    label: c.state === 'permission' ? 'Needs setup' : named,
    detail: `${why}${c.reason}`,
    reasonCode: c.reasonCode,
    actions: [...actions, ...fix],
  };
}

/** The System Settings panes Codex Computer Use needs, and the re-check once they are on. */
const PERMISSION_ACTIONS = [
  { kind: 'url', label: 'Open Accessibility settings', url: PRIVACY_PANES.accessibility },
  { kind: 'url', label: 'Open Screen Recording settings', url: PRIVACY_PANES.screenRecording },
  { kind: 'retry', label: 'Check again' },
];

/**
 * What the Codex row says while native computer use is on but needs something: MoPilot updating the
 * installed copy (or that update failing), or a permission Codex Computer Use reported missing. Null when
 * there is nothing to say.
 */
function codexComputerNotice(/** @type {SkyState} */ { install, permissions }) {
  if (install?.phase === 'waiting')
    return {
      state: 'update',
      label: 'Update waiting',
      reasonCode: 'codex.waiting',
      detail: `MoPilot updates Codex Computer Use to ${install.version} once no loaded Codex chat is using it.`,
      actions: [],
    };
  if (install?.phase === 'running')
    return {
      state: 'update',
      label: 'Updating',
      reasonCode: 'codex.installing',
      detail: `MoPilot is updating Codex Computer Use to ${install.version}.`,
      actions: [],
    };
  if (install?.phase === 'failed')
    return {
      state: 'update',
      label: 'Update failed',
      reasonCode: 'codex.installFailed',
      detail: `MoPilot couldn't update Codex Computer Use to ${install.version}: ${install.error}`,
      actions: [TRY_AGAIN],
    };
  if (permissions)
    return {
      state: 'permissions',
      label: 'Needs permission',
      reasonCode: 'codex.permissions',
      // an update replaces the installed copy, so a switch that is already on can still belong to the old one
      detail: `Codex Computer Use needs Accessibility and Screen & System Audio Recording. In System Settings → Privacy & Security, turn on “Codex Computer Use” in both lists, then choose Check again. ${staleGrantHint('Codex Computer Use', 'both lists', 'choose Check again')}`,
      actions: PERMISSION_ACTIONS,
    };
  return null;
}

/** The installed Codex Computer Use version, as the Codex row names it; null when unknown. */
const skyVersionLabel = (facts) => (facts.codex.sky.version ? `Codex Computer Use ${facts.codex.sky.version}` : null);

/**
 * A computer surface without the native path: MoPilot's computer use as the health record has it
 * (helper, permissions, switch) for this harness's tool channel; green only when it is ready.
 * @param {{ reason: string, setup: any, reasonCode?: string } | null} gap why the native path isn't used
 * @param {{ health: Health, harness: 'claude' | 'codex' | 'acp' }} o
 */
function computerFallback(gap, { health, harness }, nativeExpected) {
  const actions = gap?.setup ? [gap.setup] : [];
  const why = gap?.reason ? `${gap.reason} ` : '';
  const c = health.computer;
  if (!health.channels[harness]) return unavailable(`${why}${NO_CHANNEL[harness]}`, actions, 'tools.off');
  const fix = c.fix ? [c.fix] : [];
  if (!c.usable) return unavailable(`${why}${c.reason}`, [...actions, ...fix], c.reasonCode);
  const label = nativeExpected ? 'Fallback (MoPilot computer use)' : 'MoPilot computer use';
  if (c.state === 'ready')
    return { state: nativeExpected ? 'fallback' : 'mopilot', label, detail: gap?.reason ?? null, reasonCode: gap?.reasonCode, actions };
  const named = { permission: 'Needs permission', error: "Couldn't start", unknown: label }[c.state];
  return {
    state: SETUP_STATE[c.state],
    label: named,
    detail: `${why}${c.reason}`,
    reasonCode: c.reasonCode,
    actions: [...actions, ...fix],
  };
}

/**
 * The per-harness status the settings show: for each harness, Chrome and Computer, which path it gets.
 * MoPilot's own surfaces come from the capability health record only (`live.health`).
 * @param {ReturnType<typeof import('./probe.cjs').probeNativeAvailability>} facts
 * @param {{ codexNative: boolean, codexNativeComputer?: boolean, claudeFlag: boolean, claudeEligible: boolean, health: Health, chromeServed?: ChromeServed, codexChromeBackend?: boolean }} live
 *   chromeServed: the sessions MoPilot's own channel serves the user's Chrome to; without it, none
 * @param {SkyState} [sky]
 */
function availabilityStatus(facts, live, sky = {}) {
  const { health } = live;
  const served = live.chromeServed ?? NOT_SERVED;
  const tools = { health, served: served.tools, kind: served.kind };
  const route = codexChromeRoute(served);
  const codex = codexNativeSurfaces(facts, { ...live, enabled: live.codexNative, skyReport: sky.skyReport, skyDown: !!sky.skyDown });
  const cChrome = codexChromeGap(facts, live.codexNative, { route, backend: live.codexChromeBackend, health });
  const backendRow =
    live.codexNative && route === 'backend'
      ? cChrome
        ? health.yourChrome.usable
          ? chromeFallback(cChrome, { health, harness: 'codex' }, true)
          : unavailable(cChrome.reason, cChrome.setup ? [cChrome.setup] : [], cChrome.reasonCode)
        : ownChromeFallback(
            null,
            health.chromeRelay ?? {
              state: 'unknown',
              usable: true,
              reason: "MoPilot's Chrome connection hasn't been checked.",
              fix: null,
            },
            { health, harness: 'codex', label: OWN_CHROME[served.kind] ?? "MoPilot's Chrome backend", needsChannel: false },
            false,
          )
      : null;
  const cComputer = codexComputerGap(facts, live.codexNative, { ...sky, nativeComputer: live.codexNativeComputer });
  const chosenManaged = cComputer?.reasonCode === 'native.choice';
  const clChrome = claudeChromeGap(facts, { flag: live.claudeFlag, eligible: live.claudeEligible });
  return {
    harnesses: [
      {
        harness: 'codex',
        label: 'Codex',
        chrome:
          backendRow ??
          (live.codexNative && route === 'tools'
            ? chromeFallback(null, { ...tools, harness: 'codex' }, false)
            : codex.chrome
              ? { state: 'native', label: 'Native (OpenAI extension)', detail: null, actions: [] }
              : chromeFallback(
                  cChrome,
                  { health, harness: 'codex', served: live.codexNative ? served.codex : served.tools, kind: served.kind },
                  true,
                )),
        computer: {
          ...(codex.computer
            ? (codexComputerNotice(sky) ?? { state: 'native', label: 'Native (Codex Computer Use)', detail: null, actions: [] })
            : computerFallback(cComputer, { health, harness: 'codex' }, !chosenManaged)),
          // MoPilot's computer use chosen (Settings): its own row, not a fallback, and no Codex Computer Use version
          version: chosenManaged ? null : skyVersionLabel(facts),
        },
      },
      {
        harness: 'claude',
        label: 'Claude Code',
        chrome: clChrome
          ? chromeFallback(clChrome, { ...tools, harness: 'claude' }, true)
          : { state: 'native', label: 'Native (Claude in Chrome)', detail: null, actions: [], linkStatus: true },
        computer: computerFallback(null, { health, harness: 'claude' }, false),
      },
      {
        harness: 'acp',
        label: 'Other harnesses',
        chrome: chromeFallback(null, { ...tools, harness: 'acp' }, false),
        computer: computerFallback(null, { health, harness: 'acp' }, false),
      },
    ],
    // the Claude in Chrome note and the Browser settings name MoPilot's own channel only while it can serve sessions
    // (a switch turned on after startup needs a restart first: the chrome_* tools aren't registered until then)
    chromeTools: served.tools && !!health.chromeRelay?.usable,
    extension: extensionStatus(health.chromeRelay),
  };
}

/**
 * What a native Codex thread's model is told about a surface the vendor plugin can't serve here, so it
 * neither reports success nor stays silent: MoPilot's tool to use instead, only when the health record
 * says it can work, else that the surface is unavailable, why, and what the user can do.
 * @param {ReturnType<typeof import('./probe.cjs').probeNativeAvailability>} facts
 * @param {{ chrome: boolean, computer: boolean, chromeRoute?: 'vendor' | 'tools' | 'backend', chromePending?: boolean }} surfaces what the thread was loaded with
 * @param {{ serverName: string, health: Health, chromeServed?: ChromeServed, codexChromeBackend?: boolean }} live
 * @param {SkyState} [sky]
 * @returns {string | null}
 */
function codexDegradedNote(facts, surfaces, { serverName, health, chromeServed, codexChromeBackend }, sky = {}) {
  // the thread keeps the surfaces it was loaded with; what was set up since then applies from its next load
  const later = { reason: 'it was not set up when this chat was loaded', setup: null };
  const parts = [];
  if (!surfaces.computer) {
    const gap = codexComputerGap(facts, true, sky) ?? later;
    const head = `Computer use through the Computer plugin is unavailable here (${gap.reason})`;
    const c = health.computer;
    const fix = gap.setup ?? c.fix;
    parts.push(
      c.usable
        ? `${head}; use the desktop_* tools of the ${serverName} MCP server to control apps.`
        : `${head}, and MoPilot's computer use can't be used either (${c.reason}) If a task needs computer use, say it is unavailable${fix ? ` and that the user can fix it with "${fix.label}" in MoPilot's Computer use settings` : ''}. Do not work around it.`,
    );
  }
  if (!surfaces.chrome) {
    if (surfaces.chromePending) {
      parts.push("MoPilot's Chrome backend is still starting. Wait for it to finish; do not use another Chrome backend.");
      return `MoPilot native control: ${parts.join(' ')}`;
    }
    const current = codexChromeRoute(chromeServed);
    const route = surfaces.chromeRoute ?? current;
    const reload = { reason: 'this chat must be reloaded to apply the selected Chrome route', setup: null };
    const gap =
      route !== current
        ? reload
        : (codexChromeGap(facts, true, { route, backend: codexChromeBackend, health }) ?? (surfaces.chromeRoute ? reload : later));
    const head = `The Browser plugin cannot reach the user's Chrome here (${gap.reason})`;
    if (route === 'backend' || route !== current) {
      const next =
        route !== current
          ? 'Reload this chat to apply the selected Chrome route.'
          : "Reload this chat and check MoPilot's extension in Browser settings.";
      parts.push(`${head}. ${next} Do not use another Chrome backend.`);
      return `MoPilot native control: ${parts.join(' ')}`;
    }
    const yc = health.yourChrome;
    const how = `${gap.setup ? 'install ChatGPT for Chrome or ' : ''}${yc.state === 'off' ? 'choose Your Chrome' : 'fix Your Chrome'} in MoPilot's Browser settings`;
    parts.push(
      yc.usable
        ? `${head}; use the sage_browser_* tools of the ${serverName} MCP server for the user's Chrome.`
        : `${head}, and Your Chrome can't be used either (${yc.reason}) If a task needs the user's Chrome, say it is unavailable and that the user can ${how}. Do not work around it.`,
    );
  }
  return parts.length ? `MoPilot native control: ${parts.join(' ')}` : null;
}

module.exports = { codexNativeSurfaces, availabilityStatus, codexDegradedNote, extensionStatus, skyBroken, LINKS };
