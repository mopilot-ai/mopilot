// The iOS Simulator driver behind ios_simulator_control and ios_simulator_logs. simctl (Xcode) boots devices, launches apps,
// takes screenshots and reads logs; it cannot send touches, so tap/swipe/text/button/key/inspect go through idb when it is
// installed and are reported as unavailable, with the install hint, when it is not. Anything simctl and idb cannot do
// (touch paths, rotation, the keyboard toggle) says so instead of pretending. Each chat attaches to one device.
const os = require('node:os');
const path = require('node:path');
const { ToolError } = require('../contract/registry.cjs');
const { BUNDLE, SINCE, matching, coord, pngSize, tail, why } = require('./common.cjs');

const IDB_HINT =
  'idb is not installed (brew install facebook/fb/idb-companion && pip3 install fb-idb). Screenshots, launch and logs work without it.';
const BUTTONS = ['HOME', 'LOCK', 'SIRI', 'SIDE_BUTTON', 'APPLE_PAY'];
/** HID usage codes for the keys named most often; any other key is given as its number. */
const HID = { return: 40, enter: 40, escape: 41, delete: 42, backspace: 42, tab: 43, space: 44 };
const UNSUPPORTED = {
  touch_path: 'touch_path is not supported on iOS (idb has no multi-point touch). Use swipe for a straight drag.',
  rotate: 'rotate is not supported on iOS (simctl and idb cannot rotate a device). Use Device > Rotate in the Simulator app.',
  set_keyboard: 'set_keyboard is not supported on iOS (simctl and idb cannot toggle the software keyboard).',
};

/**
 * @param {object} o
 * @param {ReturnType<typeof import('../../platform/simulatorExec.cjs').createExec>} o.exec
 * @param {(what: string, error: unknown) => void} [o.noteIgnored] records an error that is ignored on purpose
 * @param {string} [o.tmp] a folder for screenshots
 * @param {() => number} [o.now]
 * @param {string} [o.home]
 */
function createIos(o) {
  const { exec } = o;
  const noteIgnored = o.noteIgnored ?? (() => undefined);
  const tmp = o.tmp ?? os.tmpdir();
  const now = o.now ?? Date.now;
  const home = o.home ?? os.homedir();
  /** @type {Map<string, string>} chat id -> the UDID it is attached to */
  const attached = new Map();
  const simctl = (args, opts) => exec.run('xcrun', ['simctl', ...args], opts);

  const needMac = () => {
    if (exec.platform !== 'darwin')
      throw new ToolError('The iOS Simulator needs macOS with Xcode. This computer is not a Mac.', 'unavailable');
  };
  /** A simctl call that must succeed; a missing xcrun is reported as the missing toolchain it is. */
  async function must(args, what, opts) {
    const r = await simctl(args, opts);
    if (r.missing)
      throw new ToolError(
        'Xcode command line tools are not installed (xcrun not found). Install Xcode, then run xcode-select --install.',
        'unavailable',
      );
    if (!r.ok) throw new ToolError(`${what} failed: ${why(r)}`, 'failed');
    return r;
  }
  const deviceOf = (chatId) => {
    const udid = attached.get(chatId);
    if (!udid) throw new ToolError('No simulator is attached. Call control with action "attach" first.', 'not_attached');
    return udid;
  };
  /** An idb call; without idb, the install hint. */
  async function viaIdb(args, udid, what, positional = []) {
    const bin = exec.locate('idb');
    if (!bin) throw new ToolError(`${what} needs idb. ${IDB_HINT}`, 'unavailable');
    const r = await exec.run(bin, [...args, '--udid', udid, ...(positional.length ? ['--', ...positional] : [])]);
    if (!r.ok) throw new ToolError(`${what} failed: ${why(r)}`, 'failed');
    return r;
  }

  async function devices() {
    const r = await must(['list', 'devices', 'available', '-j'], 'Listing simulators');
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      throw new ToolError('Listing simulators failed: simctl returned unreadable output', 'failed');
    }
    return Object.entries(json.devices ?? {})
      .reverse()
      .flatMap(([runtime, list]) =>
        (list ?? []).map((d) => ({ udid: d.udid, name: d.name, state: d.state, runtime: runtime.replace(/^.*SimRuntime\./, '') })),
      );
  }

  async function attach(chatId, a) {
    const all = await devices();
    if (!all.length) throw new ToolError('No iOS simulators are installed. Add a runtime in Xcode > Settings > Platforms.', 'unavailable');
    const want = a.device === undefined ? null : String(a.device);
    const pick = want
      ? all.find((d) => d.udid.toLowerCase() === want.toLowerCase() || d.name.toLowerCase() === want.toLowerCase())
      : (all.find((d) => d.state === 'Booted') ?? all.find((d) => d.name.startsWith('iPhone')) ?? all[0]);
    if (!pick)
      throw new ToolError(
        `No simulator "${want}". Installed: ${all
          .slice(0, 12)
          .map((d) => `${d.name} (${d.udid})`)
          .join(', ')}`,
        'not_found',
      );
    if (pick.state !== 'Booted') {
      const b = await simctl(['boot', pick.udid]);
      // booting a device that finished booting meanwhile is fine
      if (!b.ok && !/current state: Booted/i.test(b.stderr)) throw new ToolError(`Booting ${pick.name} failed: ${why(b)}`, 'failed');
      await must(['bootstatus', pick.udid, '-b'], `Waiting for ${pick.name} to boot`, { timeout: 180_000 });
    }
    // the window lets the user watch; a failure to open it does not stop the session
    await exec.run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', pick.udid]);
    attached.set(chatId, pick.udid);
    const input = exec.locate('idb') ? 'Touch, text and inspect are available (idb).' : `Touch, text and inspect are not: ${IDB_HINT}`;
    return `Attached to ${pick.name} (${pick.udid}, ${pick.runtime}). ${input} Next: launch an app or take a screenshot.`;
  }

  async function screenshot(udid) {
    const file = path.join(tmp, `mopilot-sim-${udid}-${now()}.png`);
    await must(['io', udid, 'screenshot', '--type=png', file], 'Screenshot');
    try {
      const buf = exec.readFile(file);
      const size = pngSize(buf);
      const dims = size ? `${size.w}x${size.h} pixels` : 'unknown size';
      return [
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
        {
          type: 'text',
          text: `Screenshot, ${dims}. Tap and swipe coordinates are in screen points: pixels divided by the device scale (2 or 3).`,
        },
      ];
    } finally {
      try {
        exec.removeFile(file);
      } catch (e) {
        noteIgnored('remove a simulator screenshot', e);
      }
    }
  }

  /** The accessibility tree from idb as one line per element, or idb's text when it is not JSON. */
  function describe(text) {
    let list;
    try {
      list = JSON.parse(text);
    } catch {
      return tail(text, 400);
    }
    const lines = (Array.isArray(list) ? list : [list]).map((e) => {
      const f = e.frame ?? {};
      const at = `(${Math.round(f.x ?? 0)},${Math.round(f.y ?? 0)} ${Math.round(f.width ?? 0)}x${Math.round(f.height ?? 0)})`;
      return `${e.type ?? e.role ?? 'Element'} ${JSON.stringify(e.AXLabel ?? e.label ?? '')} ${at}`;
    });
    return tail(lines.join('\n'), 400, 'elements');
  }

  const pt = (v, what) => coord(v, what).toString();

  async function control(chatId, a) {
    needMac();
    const action = String(a.action ?? '');
    if (action === 'attach') return attach(chatId, a);
    if (UNSUPPORTED[action]) throw new ToolError(UNSUPPORTED[action], 'unsupported');
    const udid = deviceOf(chatId);
    switch (action) {
      case 'detach':
        attached.delete(chatId);
        return 'Detached. The simulator keeps running; attach again to continue.';
      case 'launch': {
        const app = matching(a.app, BUNDLE, 'app (bundle id)');
        const r = await must(['launch', udid, app], `Launching ${app}`);
        return `Launched ${app}${/:\s*(\d+)/.test(r.stdout) ? ` (pid ${/:\s*(\d+)/.exec(r.stdout)?.[1]})` : ''}. Take a screenshot to see it.`;
      }
      case 'screenshot':
        return screenshot(udid);
      case 'inspect':
        return describe((await viaIdb(['ui', 'describe-all', '--json'], udid, 'inspect')).stdout);
      case 'tap':
        await viaIdb(['ui', 'tap', pt(a.x, 'x'), pt(a.y, 'y')], udid, 'tap');
        return `Tapped (${coord(a.x, 'x')}, ${coord(a.y, 'y')}).`;
      case 'swipe': {
        const from = [pt(a.x, 'x'), pt(a.y, 'y')];
        const to = [pt(a.to_x, 'to_x'), pt(a.to_y, 'to_y')];
        await viaIdb(
          ['ui', 'swipe', ...from, ...to, '--duration', String(Math.min(Math.max(Number(a.duration) || 0.3, 0.05), 10))],
          udid,
          'swipe',
        );
        return `Swiped from (${from.join(', ')}) to (${to.join(', ')}).`;
      }
      case 'text': {
        const text = String(a.text ?? '');
        if (!text) throw new ToolError('text is required', 'bad_args');
        await viaIdb(['ui', 'text'], udid, 'text', [text]);
        return `Typed ${text.length} characters.`;
      }
      case 'button': {
        const b = String(a.button ?? '').toUpperCase();
        if (!BUTTONS.includes(b)) throw new ToolError(`button must be one of ${BUTTONS.join(', ')}`, 'bad_args');
        await viaIdb(['ui', 'button', b], udid, 'button');
        return `Pressed ${b}.`;
      }
      case 'press_key': {
        const raw = String(a.key ?? '').trim();
        const code = HID[raw.toLowerCase()] ?? (/^\d{1,3}$/.test(raw) ? Number(raw) : null);
        if (code === null) throw new ToolError(`key must be a HID usage number or one of ${Object.keys(HID).join(', ')}`, 'bad_args');
        await viaIdb(['ui', 'key', String(code)], udid, 'press_key');
        return `Pressed key ${raw}.`;
      }
      default:
        throw new ToolError(`Unknown action "${action}"`, 'bad_args');
    }
  }

  /** The newest crash report (last 24 h) for a process, from the user's diagnostic reports. */
  function crash(a) {
    const dir = path.join(home, 'Library', 'Logs', 'DiagnosticReports');
    let names;
    try {
      names = exec.listDir(dir);
    } catch {
      throw new ToolError(`No crash reports folder at ${dir}`, 'not_found');
    }
    const needle = a.process === undefined ? '' : String(a.process).toLowerCase();
    const found = names
      .filter((n) => /\.(ips|crash)$/.test(n) && n.toLowerCase().includes(needle))
      .map((n) => ({ n, t: exec.modifiedAt(path.join(dir, n)) }))
      .filter((f) => now() - f.t < 24 * 3600_000)
      .sort((x, y) => y.t - x.t)[0];
    if (!found) throw new ToolError(`No crash report from the last 24 hours${needle ? ` for "${a.process}"` : ''}.`, 'not_found');
    return `${found.n}\n${tail(exec.readText(path.join(dir, found.n)), a.lines ?? 400)}`;
  }

  async function logs(chatId, a) {
    needMac();
    const action = String(a.action ?? 'read');
    if (action === 'crash_report') return crash(a);
    if (action !== 'read') throw new ToolError(`Unknown action "${action}"`, 'bad_args');
    const udid = deviceOf(chatId);
    const quote = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const parts = [];
    if (a.process) parts.push(`process == "${quote(a.process)}"`);
    if (a.filter) parts.push(`eventMessage CONTAINS[c] "${quote(a.filter)}"`);
    const since = a.since === undefined ? '5m' : matching(a.since, SINCE, 'since (like 30s, 5m, 1h)');
    const r = await must(
      ['spawn', udid, 'log', 'show', '--last', since, '--style', 'compact', ...(parts.length ? ['--predicate', parts.join(' AND ')] : [])],
      'Reading logs',
      { timeout: 60_000 },
    );
    return tail(r.stdout, a.lines);
  }

  return { control, logs };
}

module.exports = { createIos, IDB_HINT };
