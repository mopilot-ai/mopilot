// The Android Emulator driver behind android_emulator_control and android_emulator_logs, over adb (and the emulator binary
// to start an AVD by name). Works on any OS with the Android SDK; a missing adb is reported as the missing toolchain.
// Each chat attaches to one device serial; coordinates are screen pixels, the same as the screenshot.
const { ToolError } = require('../contract/registry.cjs');
const { SERIAL, PACKAGE, AVD, KEY, matching, coord, pathOf, pngSize, tail, why } = require('./common.cjs');

const ADB_HINT =
  'adb is not installed. Install the Android SDK platform-tools (Android Studio, or brew install --cask android-platform-tools).';
const BUTTONS = {
  HOME: 'KEYCODE_HOME',
  BACK: 'KEYCODE_BACK',
  RECENTS: 'KEYCODE_APP_SWITCH',
  LOCK: 'KEYCODE_POWER',
  VOLUME_UP: 'KEYCODE_VOLUME_UP',
  VOLUME_DOWN: 'KEYCODE_VOLUME_DOWN',
};
const ROTATIONS = { portrait: 0, landscape: 1, reverse_portrait: 2, reverse_landscape: 3 };
const BOOT_POLLS = 45;
const BOOT_POLL_MS = 2000;

/** A string as one argument of the device shell: single-quoted, spaces as %s for `input text`. */
const shellText = (s) => `'${String(s).replace(/ /g, '%s').replace(/'/g, "'\\''")}'`;

/**
 * @param {object} o
 * @param {ReturnType<typeof import('../../platform/simulatorExec.cjs').createExec>} o.exec
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
function createAndroid(o) {
  const { exec } = o;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  /** @type {Map<string, string>} chat id -> the adb serial it is attached to */
  const attached = new Map();

  const adbPath = () => {
    const p = exec.locate('adb');
    if (!p) throw new ToolError(ADB_HINT, 'unavailable');
    return p;
  };
  /** An adb call that must succeed. `serial` null: no device selected. */
  async function adb(serial, args, what, opts) {
    const r = await exec.run(adbPath(), serial ? ['-s', serial, ...args] : args, opts);
    if (!r.ok) throw new ToolError(`${what} failed: ${why(r)}`, 'failed');
    return r;
  }
  const shell = (serial, args, what, opts) => adb(serial, ['shell', ...args], what, opts);
  const deviceOf = (chatId) => {
    const serial = attached.get(chatId);
    if (!serial) throw new ToolError('No emulator is attached. Call control with action "attach" first.', 'not_attached');
    return serial;
  };

  /** Serials of the devices adb sees that are online. */
  async function online() {
    const r = await adb(null, ['devices'], 'Listing devices');
    return String(r.stdout)
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter(([, state]) => state === 'device')
      .map(([serial]) => serial);
  }
  const booted = async (serial) =>
    (await exec.run(adbPath(), ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'])).stdout?.toString().trim() === '1';

  async function avds() {
    const p = exec.locate('emulator');
    if (!p) return null;
    const r = await exec.run(p, ['-list-avds']);
    return r.ok
      ? String(r.stdout)
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }

  /** Starts the named AVD and waits for a new emulator to finish booting. */
  async function startAvd(name) {
    const list = await avds();
    if (list === null)
      throw new ToolError(
        'The Android emulator is not installed (no emulator binary in the SDK). Install it with the SDK Manager.',
        'unavailable',
      );
    if (!list.includes(name))
      throw new ToolError(`No AVD "${name}". Available: ${list.join(', ') || 'none (create one in Android Studio)'}`, 'not_found');
    const before = new Set(await online());
    exec.startDetached(String(exec.locate('emulator')), ['-avd', name]);
    for (let i = 0; i < BOOT_POLLS; i += 1) {
      await sleep(BOOT_POLL_MS);
      const fresh = (await online()).find((s) => !before.has(s));
      if (fresh && (await booted(fresh))) return fresh;
    }
    throw new ToolError(
      `AVD "${name}" did not finish booting in ${(BOOT_POLLS * BOOT_POLL_MS) / 1000} seconds. Check it in the emulator window and attach again.`,
      'timeout',
    );
  }

  async function attach(chatId, a) {
    adbPath();
    let serial;
    if (a.avd !== undefined) serial = await startAvd(matching(a.avd, AVD, 'avd'));
    else {
      const list = await online();
      const want = a.device === undefined ? null : matching(a.device, SERIAL, 'device');
      // without a name only an emulator is taken, never a phone on USB
      serial = want ? list.find((s) => s === want) : list.find((s) => /^emulator-\d+$/.test(s));
      if (!serial) {
        const names = await avds();
        const hint =
          names === null
            ? 'The emulator binary is not installed either.'
            : `Start one with attach and avd set to one of: ${names.join(', ') || 'none (create one in Android Studio)'}.`;
        throw new ToolError(`${want ? `Device "${want}" is not online.` : 'No emulator or device is online.'} ${hint}`, 'not_found');
      }
    }
    attached.set(chatId, serial);
    return `Attached to ${serial}. Next: launch an app or take a screenshot.`;
  }

  async function screenshot(serial) {
    const r = await adb(serial, ['exec-out', 'screencap', '-p'], 'Screenshot', { binary: true });
    const buf = Buffer.from(r.stdout);
    const size = pngSize(buf);
    if (!size) throw new ToolError('Screenshot failed: the device did not return a PNG', 'failed');
    return [
      { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `Screenshot, ${size.w}x${size.h} pixels. Tap and swipe coordinates are in the same pixels.` },
    ];
  }

  /** The visible, useful nodes of a uiautomator dump as one line each. */
  function elements(xml) {
    const out = [];
    for (const m of xml.matchAll(/<node\b([^>]*)>/g)) {
      const attr = (n) => new RegExp(`\\b${n}="([^"]*)"`).exec(m[1])?.[1] ?? '';
      const text = attr('text') || attr('content-desc');
      const clickable = attr('clickable') === 'true';
      if (!text && !clickable) continue;
      const id = attr('resource-id').replace(/^.*:id\//, '');
      out.push(
        `${attr('class').replace(/^.*\./, '')}${id ? ` #${id}` : ''} ${JSON.stringify(text)}${clickable ? ' clickable' : ''} ${attr('bounds')}`,
      );
    }
    return out.length ? tail(out.join('\n'), 400, 'elements') : 'No labelled or clickable elements on screen.';
  }

  async function control(chatId, a) {
    const action = String(a.action ?? '');
    if (action === 'attach') return attach(chatId, a);
    const serial = deviceOf(chatId);
    const key = (name) => shell(serial, ['input', 'keyevent', name], action);
    switch (action) {
      case 'detach':
        attached.delete(chatId);
        return 'Detached. The emulator keeps running; attach again to continue.';
      case 'launch': {
        const pkg = matching(a.app, PACKAGE, 'app (package name)');
        const r = await shell(serial, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], `Launching ${pkg}`);
        if (/No activities found/i.test(`${r.stdout}${r.stderr}`))
          throw new ToolError(`Launching ${pkg} failed: the package has no launcher activity (is it installed?)`, 'failed');
        return `Launched ${pkg}. Take a screenshot to see it.`;
      }
      case 'screenshot':
        return screenshot(serial);
      case 'inspect':
        return elements(
          String((await adb(serial, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], 'inspect', { timeout: 60_000 })).stdout),
        );
      case 'tap':
        await shell(serial, ['input', 'tap', String(coord(a.x, 'x')), String(coord(a.y, 'y'))], 'tap');
        return `Tapped (${coord(a.x, 'x')}, ${coord(a.y, 'y')}).`;
      case 'swipe': {
        const p = [coord(a.x, 'x'), coord(a.y, 'y'), coord(a.to_x, 'to_x'), coord(a.to_y, 'to_y')];
        const ms = Math.round(Math.min(Math.max(Number(a.duration) || 0.3, 0.05), 10) * 1000);
        await shell(serial, ['input', 'swipe', ...p.map(String), String(ms)], 'swipe');
        return `Swiped from (${p[0]}, ${p[1]}) to (${p[2]}, ${p[3]}).`;
      }
      case 'touch_path': {
        const pts = pathOf(a.points);
        const at = (p) => [String(p.x), String(p.y)];
        await shell(serial, ['input', 'motionevent', 'DOWN', ...at(pts[0])], 'touch_path');
        let last = pts[0];
        try {
          for (const p of pts.slice(1)) {
            await shell(serial, ['input', 'motionevent', 'MOVE', ...at(p)], 'touch_path');
            last = p;
          }
        } finally {
          // never leave the pointer pressed on the device
          await exec.run(adbPath(), ['-s', serial, 'shell', 'input', 'motionevent', 'UP', ...at(last)]);
        }
        return `Dragged through ${pts.length} points.`;
      }
      case 'text': {
        const text = String(a.text ?? '');
        if (!text) throw new ToolError('text is required', 'bad_args');
        await shell(serial, ['input', 'text', shellText(text)], 'text');
        return `Typed ${text.length} characters.`;
      }
      case 'button': {
        const b = String(a.button ?? '').toUpperCase();
        if (!BUTTONS[b]) throw new ToolError(`button must be one of ${Object.keys(BUTTONS).join(', ')}`, 'bad_args');
        await key(BUTTONS[b]);
        return `Pressed ${b}.`;
      }
      case 'press_key': {
        const name = String(a.key ?? '')
          .trim()
          .toUpperCase();
        matching(name, KEY, 'key (an Android KEYCODE_ name or number)');
        await key(/^\d+$/.test(name) || name.startsWith('KEYCODE_') ? name : `KEYCODE_${name}`);
        return `Pressed key ${name}.`;
      }
      case 'set_keyboard': {
        const on = a.visible !== false;
        await shell(serial, ['settings', 'put', 'secure', 'show_ime_with_hard_keyboard', on ? '1' : '0'], 'set_keyboard');
        return `On-screen keyboard ${on ? 'shown' : 'hidden'} when a hardware keyboard is connected.`;
      }
      case 'rotate': {
        const o2 = ROTATIONS[String(a.orientation ?? '')];
        if (o2 === undefined) throw new ToolError(`orientation must be one of ${Object.keys(ROTATIONS).join(', ')}`, 'bad_args');
        await shell(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '0'], 'rotate');
        await shell(serial, ['settings', 'put', 'system', 'user_rotation', String(o2)], 'rotate');
        return `Rotated to ${a.orientation}.`;
      }
      case 'airplane_mode': {
        const on = a.enabled !== false;
        await shell(serial, ['settings', 'put', 'global', 'airplane_mode_on', on ? '1' : '0'], 'airplane_mode');
        await shell(
          serial,
          ['am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', on ? 'true' : 'false'],
          'airplane_mode',
        );
        return `Airplane mode ${on ? 'on' : 'off'}.`;
      }
      default:
        throw new ToolError(`Unknown action "${action}"`, 'bad_args');
    }
  }

  async function logs(chatId, a) {
    const action = String(a.action ?? 'read');
    if (action !== 'read' && action !== 'crash_report') throw new ToolError(`Unknown action "${action}"`, 'bad_args');
    const serial = deviceOf(chatId);
    const crash = action === 'crash_report';
    const args = [
      'logcat',
      '-d',
      ...(crash ? ['-b', 'crash'] : []),
      '-t',
      // a filter searches the whole buffer window, then the last lines of what matched are kept
      a.filter === undefined ? String(Math.min(Math.max(Math.trunc(Number(a.lines)) || 200, 1), 1000)) : '5000',
    ];
    const r = await adb(serial, args, 'Reading logs', { timeout: 60_000 });
    const needle = a.filter === undefined ? '' : String(a.filter).toLowerCase();
    const lines = needle
      ? String(r.stdout)
          .split('\n')
          .filter((l) => l.toLowerCase().includes(needle))
          .join('\n')
      : String(r.stdout);
    return crash && !lines.trim() ? 'No crashes in the device crash log.' : tail(lines, a.lines);
  }

  return { control, logs };
}

module.exports = { createAndroid, ADB_HINT };
