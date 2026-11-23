// Codex's Remote Control in main: the one app-server's link to the user's other devices (remoteControl/* on the main app-server),
// switched from the Environment card. It is the computer's, not a chat's, so it lives beside the adapter, not in a chat's session.
// It is always asked for ephemerally: the link lasts as long as this app-server process and is never written to Codex's config,
// so a restart or a quit takes it down and nothing turns it back on without the user.
const { prefixUnits, suffixUnits } = require('../../shared/textPrefix.mjs');
const NEEDS_LOGIN = 'Sign in with ChatGPT to use Remote Control.';
// the app-server's errored notification carries no reason (openai/codex app-server-transport logs it with warn! only, and retries
// with backoff); this is what the row says instead of nothing
const UNREACHABLE = "Couldn't connect. Check your ChatGPT account and network.";

/** What the user reads for a refusal: the app-server's words, except for the one every signed-out login gets. */
function messageFor(error) {
  const text = String(error?.message ?? error);
  return /ChatGPT authentication/i.test(text) ? NEEDS_LOGIN : text;
}

/** A WARN or ERROR line the app-server's remote-control module logged (its tracing target holds `remote_control`), the message after the target. */
const LOG_LINE = /\b(?:WARN|ERROR)\s+\S*remote_control\S*?:\s+(.*)$/;
const ANSI = /\x1b\[[0-9;]*m/g;
const MAX_DETAIL = 140;

/** The message of a remote-control log line, short and without anything secret; null for any other line. */
function detailOf(line) {
  const message = LOG_LINE.exec(line.replace(ANSI, ''))?.[1];
  if (!message) return null;
  const text = message
    // tracing prints the message, then its key=value fields (urls, ids, headers): the fields stay out
    .split(/\s[A-Za-z_][\w.]*=/)[0]
    // a link keeps its host and path, never its query
    .replace(/\?[^\s"'`]*/g, '')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
    .replace(/\beyJ[\w.-]+/g, '[redacted]')
    .replace(/\b[\w-]{32,}\b/g, '[redacted]')
    .trim();
  if (!text) return null;
  return text.length > MAX_DETAIL ? `${prefixUnits(text, MAX_DETAIL - 1)}…` : text;
}

/**
 * @typedef {{ status: 'disabled' | 'connecting' | 'connected' | 'errored', environmentId: string | null, error: string | null,
 *   detail: string | null, retrying: boolean }} RemoteControlState
 * `detail`: the app-server's own last words about a failed attempt; `retrying`: it was asked to connect and is trying again
 */

class CodexRemoteControl {
  /**
   * @param {object} o
   * @param {(method: string, params?: object) => Promise<any>} o.request the main app-server's requests
   * @param {(context: string, error: unknown) => void} o.note where a failure nobody can act on is recorded
   */
  constructor({ request, note }) {
    this.request = request;
    this.note = note;
    /** @type {RemoteControlState} */
    this.view = { status: 'disabled', environmentId: null, error: null, detail: null, retrying: false };
    /** whether the user's last press asked for the link and the app-server has not refused it */
    this.wanted = false;
    /** the last remote-control line the app-server logged since the link was asked for */
    this.last = null;
    /** the end of stderr that is not a whole line yet */
    this.partial = '';
    /** whether this app-server process has told us its state (an answer or a notification) */
    this.known = false;
    /** bumped when the process ends: an answer of an older one is dropped */
    this.epoch = 0;
    this.queue = Promise.resolve();
  }

  /** @returns {RemoteControlState} */
  snapshot() {
    const { status, error } = this.view;
    // errored, or connecting again after an error, while it is wanted: the app-server retries on its own
    return { ...this.view, retrying: this.wanted && (status === 'errored' || (status === 'connecting' && error != null)) };
  }

  /** The app-server's stderr as it arrives: its remote-control warnings become the failure's detail. */
  onStderr(chunk) {
    const lines = (this.partial + chunk).split('\n');
    // the last piece has no newline yet: it waits for the rest
    const rest = lines.length - 1;
    this.partial = suffixUnits(lines[rest], 2000);
    for (const line of lines.slice(0, rest)) {
      const detail = detailOf(line);
      if (!detail) continue;
      this.last = detail;
      // the app-server publishes errored just before it logs why, so the line may arrive after the status
      if (this.view.error != null && (this.view.status === 'errored' || this.wanted)) this.view = { ...this.view, detail };
    }
  }

  /** The app-server's answer or notification about the link; a failure's words stay until the link is asked for again. */
  apply(p) {
    this.known = true;
    const errored = p.status === 'errored';
    // while it is wanted the app-server retries (errored, connecting, errored): the words stay until it connects or is turned off
    const keep = errored || (this.wanted && p.status === 'connecting' && this.view.error != null);
    this.view = {
      status: p.status,
      environmentId: p.environmentId ?? null,
      error: keep ? (this.view.error ?? UNREACHABLE) : null,
      detail: keep ? (errored ? this.last : this.view.detail) : null,
      // snapshot() works this out from the status and whether the link is wanted
      retrying: false,
    };
  }

  /** `remoteControl/status/changed`. */
  onStatus(p) {
    this.apply(p);
  }

  /** The state now: the app-server is asked once per process, then notifications keep it current. */
  async read() {
    if (this.known) return this.snapshot();
    const epoch = this.epoch;
    try {
      const answer = await this.request('remoteControl/status/read');
      // a press or a notification that came while this was asked is newer than its answer
      if (epoch === this.epoch && !this.known) this.apply(answer);
    } catch (error) {
      this.note("read Codex's Remote Control state", error);
    }
    return this.snapshot();
  }

  /** Turn the link on or off. Presses queue: each runs after the one before, so the last press is the state. */
  set(on) {
    const run = this.queue.then(() => this.send(on));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async send(on) {
    const epoch = this.epoch;
    this.wanted = on;
    if (on) {
      this.last = null;
      this.view = { ...this.view, error: null, detail: null };
    }
    try {
      const answer = await this.request(on ? 'remoteControl/enable' : 'remoteControl/disable', { ephemeral: true });
      if (epoch === this.epoch) this.apply(answer);
    } catch (error) {
      if (epoch === this.epoch) {
        // refused on the spot: nothing retries, so the switch goes back off with the app-server's words
        if (on) this.wanted = false;
        this.view = { ...this.view, status: on ? 'errored' : this.view.status, error: messageFor(error), detail: null };
      }
    }
    return this.snapshot();
  }

  /** The environment the link registered, for the calls about pairing and devices; they need the link up. */
  environment() {
    if (this.view.status !== 'connected' || !this.view.environmentId) throw new Error('Turn Remote Control on first.');
    return this.view.environmentId;
  }

  /** A short-lived code a device types to pair: the code and when it ends (seconds since the epoch). */
  async pairing() {
    this.environment();
    const answer = await this.request('remoteControl/pairing/start', { manualCode: true });
    return { code: answer.manualPairingCode ?? null, expiresAt: Number(answer.expiresAt) };
  }

  /** Whether a device has used this code. */
  async claimed(code) {
    if (typeof code !== 'string' || !code) throw new Error('No pairing code to check.');
    const answer = await this.request('remoteControl/pairing/status', { manualPairingCode: code });
    return answer.claimed === true;
  }

  /** The devices paired with this computer, most recently seen first. */
  async clients() {
    const environmentId = this.environment();
    const answer = await this.request('remoteControl/client/list', { environmentId, limit: 50, order: 'desc' });
    return (answer.data ?? []).map((c) => ({
      clientId: c.clientId,
      name: c.displayName ?? c.deviceModel ?? null,
      platform: c.platform ?? null,
      lastSeenAt: c.lastSeenAt == null ? null : Number(c.lastSeenAt),
    }));
  }

  /** Take a device's access away. */
  async revoke(clientId) {
    if (typeof clientId !== 'string' || !clientId) throw new Error('No device to revoke.');
    await this.request('remoteControl/client/revoke', { environmentId: this.environment(), clientId });
  }

  /** The app-server ended or restarted: its link went with it, and is not assumed back. */
  reset() {
    this.epoch++;
    this.known = false;
    this.view = { status: 'disabled', environmentId: null, error: null, detail: null, retrying: false };
    this.wanted = false;
    this.last = null;
    this.partial = '';
  }
}

module.exports = { CodexRemoteControl, NEEDS_LOGIN, UNREACHABLE };
