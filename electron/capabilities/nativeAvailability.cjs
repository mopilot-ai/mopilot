// Which vendor-native browser and computer control this Mac can actually run, and what each harness gets.
//
// A Codex thread on the native path (native.codex.enabled) hands Chrome and computer use to the vendor's
// bundled plugin (unified-computer-use) and MoPilot hides its own equivalents. That plugin needs the
// ChatGPT app's runtime (the plugin and its cua_node), the OpenAI Chrome extension for Chrome, and the
// Codex Computer Use app (Sky, com.openai.sky.CUAService) for computer use. A Claude Code session runs
// Claude in Chrome only with a claude.ai login (electron/harness/claude/index.cjs nativeChromeFor) and the Claude
// extension's native host. This module probes those pieces (read only, cached), decides per surface which
// path a session gets (native, MoPilot's own fallback, or none), and describes the result for the
// Browser and Computer use settings and for the model. The one thing it sets up itself is Codex Computer
// Use: a missing or older copy in the Codex home is installed from the bundled one (skyInstall.cjs), and a
// permission Codex Computer Use reports missing is fixed in System Settings from MoPilot. The user is
// never sent to the ChatGPT app; without its runtime, sessions keep MoPilot's own tools.
const { skyInstallPlan, installSky } = require('./skyInstall.cjs');
const {
  probeNativeAvailability,
  SKY_BUNDLE_ID,
  OPENAI_CHROME_HOST,
  CLAUDE_CHROME_HOSTS,
  vendorChromeProfile,
} = require('./nativeAvailability/probe.cjs');
const { codexNativeSurfaces, availabilityStatus, codexDegradedNote, skyBroken, LINKS } = require('./nativeAvailability/status.cjs');
/** How long a Codex Computer Use service that didn't start keeps Codex chats on MoPilot's computer use before a new one tries it again. */
const SKY_DOWN_RETRY_MS = 10 * 60 * 1000;
/** @typedef {import('./nativeAvailability/status.cjs').Health} Health */

/**
 * The probe, cached, refreshed at most every `minIntervalMs` (app focus) or on demand (settings opened),
 * bound to the app's live switches. With native Codex on, a probe that finds Codex Computer Use missing or
 * older than the bundled copy installs it (once per copy; Try again repeats a failed one).
 */
class NativeAvailability {
  /**
   * @param {{ probe?: () => ReturnType<typeof probeNativeAvailability>, now?: () => number, minIntervalMs?: number,
   *           live: () => { codexNative: boolean, codexNativeComputer?: boolean, claudeFlag: boolean, claudeEligible: () => boolean, health: Health,
   *                             chromeServed?: import('./nativeAvailability/status.cjs').ChromeServed, codexChromeBackend?: boolean },
   *           onChange?: () => void, install?: (plan: { source: string, target: string }) => Promise<unknown>,
   *           skyInUse?: () => boolean, skyDownRetryMs?: number }} o
   *   live.claudeEligible: read only for the status (it asks this object's claudeChromeReady itself)
   *   live.health: the capability health record's snapshot (capabilityHealth.cjs), MoPilot's own surfaces
   *   install: copies Codex Computer Use into place (skyInstall.cjs installSky)
   *   skyInUse: a loaded native Codex thread may be running the installed copy: an update waits until none is
   */
  constructor(o) {
    this.probe = o.probe ?? (() => probeNativeAvailability());
    this.now = o.now ?? Date.now;
    this.minIntervalMs = o.minIntervalMs ?? 5000;
    this.live = o.live;
    this.onChange =
      o.onChange ??
      (() => {
        /* no change listener */
      });
    this.install = o.install ?? installSky;
    this.skyInUse = o.skyInUse ?? (() => false);
    this.cached = null;
    this.at = 0;
    /** a version mismatch Codex Computer Use reported in a chat: {message, version (installed then)} */
    /** @type {{ message: string, version: string | null } | null} */
    this.skyReport = null;
    /**
     * Codex Computer Use's service didn't start in a chat (its native pipe or host service): Codex chats use MoPilot's computer use until a desktop step works again, Check again, or `skyDownRetryMs` passes (#1381)
     * @type {{ message: string, at: number } | null}
     */
    this.skyDown = null;
    this.skyDownRetryMs = o.skyDownRetryMs ?? SKY_DOWN_RETRY_MS;
    /** a permission Codex Computer Use reported missing, until a desktop step works or Check again */
    /** @type {{ kind: string } | null} */
    this.permissions = null;
    /** MoPilot's install or update of Codex Computer Use, while it runs or after it failed */
    /** @type {{ phase: 'running' | 'failed' | 'waiting', action: string, version: string, error: string | null } | null} */
    this.installState = null;
    /** the installs tried (each plan once until Try again) */
    this.attempted = new Set();
    /** the install running or last run */
    /** @type {Promise<void> | null} */
    this.installing = null;
  }

  /** The cached facts; probed on first use. */
  facts() {
    return this.cached ?? this.refresh({ force: true });
  }

  /** Probes again unless the last probe is fresh; tells onChange when what was found changed. */
  refresh({ force = false } = {}) {
    if (!force && this.cached && this.now() - this.at < this.minIntervalMs) return this.cached;
    let next;
    try {
      next = this.probe();
    } catch {
      next = probeNativeAvailability({ platform: 'unknown' });
    }
    const prev = this.cached;
    this.cached = next;
    this.at = this.now();
    if (prev && JSON.stringify(prev) !== JSON.stringify(next)) this.onChange();
    this.syncSky(next);
    return next;
  }

  /** Installs or updates Codex Computer Use from the bundled copy when native Codex is on and it is due. */
  syncSky(facts) {
    const plan = skyInstallPlan(facts.codex.sky);
    // only for someone who chose Codex Computer Use: nothing is installed for a path chats don't take
    const live = this.live();
    const due = !!plan && !!live.codexNative && live.codexNativeComputer !== false;
    // replacing the bundle under a loaded native thread breaks it: the update waits (a copy Codex reported
    // broken never does, nothing can use it), and the next refresh tries again
    const wait = due && plan?.action === 'update' && !skyBroken(facts, this.skyReport) && this.skyInUse();
    if (this.installState?.phase === 'waiting' && !wait) {
      this.installState = null;
      this.onChange();
    }
    if (!plan || !due) return;
    if (wait) {
      if (!this.installState) {
        this.installState = { action: plan.action, version: plan.version, phase: 'waiting', error: null };
        this.onChange();
      }
      return;
    }
    const key = JSON.stringify(plan);
    if (this.attempted.has(key)) return;
    this.attempted.add(key);
    const state = { action: plan.action, version: plan.version };
    this.installState = { ...state, phase: 'running', error: null };
    this.onChange();
    this.installing = Promise.resolve()
      .then(() => this.install(plan))
      .then(
        () => {
          this.installState = null;
          this.refresh({ force: true });
        },
        (e) => {
          this.installState = { ...state, phase: 'failed', error: e instanceof Error ? e.message : String(e) };
        },
      )
      .then(() => this.onChange());
  }

  /** The surfaces a Codex thread loaded now gets natively. */
  codexSurfaces() {
    const live = this.live();
    return codexNativeSurfaces(this.facts(), {
      ...live,
      enabled: !!live.codexNative,
      skyReport: this.skyReport,
      skyDown: this.skyIsDown(),
    });
  }

  /** Whether the Claude in Chrome extension side is ready (the login side is nativeChromeFor's). */
  claudeChromeReady() {
    return this.facts().claude.chrome.ready;
  }

  /** What the Codex computer row and note are told besides the probe. */
  skyState() {
    return {
      skyReport: this.skyReport,
      install: this.installState,
      permissions: this.permissions,
      skyDown: this.skyIsDown() ? this.skyDown : null,
    };
  }

  /** The note for a native Codex thread missing a surface, or null. */
  degradedNote(surfaces, serverName) {
    const live = this.live();
    return codexDegradedNote(
      this.facts(),
      surfaces,
      { ...live, serverName },
      { ...this.skyState(), nativeComputer: live.codexNativeComputer },
    );
  }

  /**
   * What Codex's computer use reported in a chat (shared/skyComputerUse.mjs). A version it doesn't support
   * sends new chats to MoPilot's computer use until a different version is installed; a service that didn't
   * start does the same until a desktop step works, Check again or the retry time (skyIsDown); a missing
   * permission makes the Codex row offer the System Settings panes until a later desktop step works
   * (`worked`, codexLifecycle.cjs) or Check again. Other problems stay with their step in the chat.
   */
  noteSkyProblem(problem) {
    const kind = problem?.kind;
    if (kind === 'versionMismatch') {
      const next = { message: problem.message, version: this.facts().codex.sky.version };
      if (JSON.stringify(next) === JSON.stringify(this.skyReport)) return;
      this.skyReport = next;
    } else if (kind === 'permissions' || kind === 'permissionsPending') {
      if (this.permissions?.kind === kind) return;
      this.permissions = { kind };
    } else if (kind === 'serviceUnavailable') {
      const was = this.skyIsDown();
      this.skyDown = { message: String(problem.message ?? ''), at: this.now() };
      if (was) return;
    } else if (kind === 'worked') {
      // Sky acted on the desktop: it has the permissions it reported missing before, and its service runs
      if (!this.permissions && !this.skyDown) return;
      this.permissions = null;
      this.skyDown = null;
    } else return;
    this.onChange();
  }

  /** Whether Codex Computer Use's service is down now (a report younger than `skyDownRetryMs`). */
  skyIsDown() {
    return !!this.skyDown && this.now() - this.skyDown.at < this.skyDownRetryMs;
  }

  /**
   * Try again / Check again: forgets a failed install (so it runs again) and a reported missing permission
   * (the next computer-use step checks it for real), then probes again. Sky's permissions are macOS privacy
   * grants of another app, which MoPilot cannot read without Full Disk Access, and Sky answers about
   * them only inside a Codex turn: its next step reports them, and a desktop step that works clears them.
   */
  retry() {
    if (this.installState?.phase !== 'running') {
      this.installState = null;
      this.attempted.clear();
    }
    this.permissions = null;
    this.skyDown = null;
    this.refresh({ force: true });
    this.onChange();
    return this.status();
  }

  /** Diagnostic evidence already recorded; never probes, installs, or reads live eligibility. */
  snapshot() {
    // the service report as recorded, also once its retry time has passed
    return { facts: this.cached, at: this.at, ...this.skyState(), skyDown: this.skyDown };
  }

  /** The per-harness status for the settings. */
  status() {
    const l = this.live();
    const facts = this.facts();
    return {
      ...availabilityStatus(
        facts,
        {
          codexNative: l.codexNative,
          codexNativeComputer: l.codexNativeComputer,
          claudeFlag: l.claudeFlag,
          claudeEligible: !!l.claudeEligible(),
          health: l.health,
          chromeServed: l.chromeServed,
          codexChromeBackend: l.codexChromeBackend,
        },
        this.skyState(),
      ),
      platform: facts.platform,
      at: this.at,
    };
  }
}
module.exports = {
  probeNativeAvailability,
  codexNativeSurfaces,
  availabilityStatus,
  codexDegradedNote,
  NativeAvailability,
  SKY_BUNDLE_ID,
  OPENAI_CHROME_HOST,
  CLAUDE_CHROME_HOSTS,
  LINKS,
  vendorChromeProfile,
};
