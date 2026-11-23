// iOS Simulator and Android Emulator tools for chats on every harness: ios_simulator_control / _logs and
// android_emulator_control / _logs. The registry advertises them on each harness's tool channel; Claude sees them on the
// mopilot_ios_simulator and mopilot_android_emulator servers as control and logs (capabilities/contract/hostServers.cjs).
// The drivers (capabilities/simulator/) run xcrun simctl / idb and adb / emulator; a missing toolchain is an accurate
// unavailable refusal. Each platform has its own switch (Settings → General); a screenshot comes back in the result, there
// is no simulator pane. Debug (lldb) and build_status are not part of this set.
const { ToolError } = require('../contract/registry.cjs');
const { createExec } = require('../../platform/simulatorExec.cjs');
const { createIos } = require('../simulator/ios.cjs');
const { createAndroid } = require('../simulator/android.cjs');

const num = (description) => ({ type: 'number', description });
const str = (description) => ({ type: 'string', description });
const CONTROL_ACTIONS = [
  'attach',
  'launch',
  'screenshot',
  'inspect',
  'tap',
  'swipe',
  'touch_path',
  'text',
  'button',
  'press_key',
  'set_keyboard',
  'detach',
  'rotate',
];

const controlSchema = (extra, actions) => ({
  type: 'object',
  properties: {
    action: { type: 'string', enum: actions, description: 'What to do. Start with attach.' },
    app: str('launch: the app to start (iOS bundle id, Android package name)'),
    x: num('tap, swipe: x of the touch (swipe: where it starts)'),
    y: num('tap, swipe: y of the touch (swipe: where it starts)'),
    to_x: num('swipe: where the swipe ends'),
    to_y: num('swipe: where the swipe ends'),
    duration: num('swipe: seconds the drag takes (default 0.3)'),
    points: {
      type: 'array',
      items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      description: 'touch_path: the points to drag through',
    },
    text: str('text: what to type into the focused field'),
    button: str('button: HOME, LOCK, SIRI, SIDE_BUTTON or APPLE_PAY (iOS); HOME, BACK, RECENTS, LOCK, VOLUME_UP or VOLUME_DOWN (Android)'),
    key: str('press_key: a HID key number or return, escape, delete, tab, space (iOS); a KEYCODE_ name or number (Android)'),
    ...extra,
  },
  required: ['action'],
  additionalProperties: false,
});
const logsSchema = (extra) => ({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['read', 'crash_report'], description: 'read: recent log lines. crash_report: the latest crash.' },
    filter: str('read: keep lines containing this text'),
    lines: num('how many of the last lines to return (default 200, at most 1000)'),
    ...extra,
  },
  additionalProperties: false,
});

const SPECS = {
  ios_simulator_control: {
    description:
      'Run and drive an iOS app in the iOS Simulator on this Mac. Call attach first (it boots a device if needed), then launch an app, screenshot to see it, and tap, swipe, text, button or press_key to use it; inspect lists the on-screen elements with their frames. Touch input, text and inspect need idb; without it they answer unavailable. Coordinates are screen points (screenshot pixels divided by the scale).',
    schema: controlSchema(
      { device: str('attach: a simulator name or UDID (default: the booted one, else an iPhone)') },
      CONTROL_ACTIONS.filter((a) => !['touch_path', 'rotate', 'set_keyboard'].includes(a)),
    ),
  },
  ios_simulator_logs: {
    description:
      "Read the attached iOS simulator's recent logs (read) or the newest crash report from the last 24 hours (crash_report). Attach first for read.",
    schema: logsSchema({
      process: str('keep one process (read), or crash reports whose file name contains this (crash_report)'),
      since: str('read: how far back, like 30s, 5m or 1h (default 5m)'),
    }),
  },
  android_emulator_control: {
    description:
      'Run and drive an Android app in the Android Emulator. Call attach first (with avd set, it starts that virtual device), then launch an app, screenshot to see it, and tap, swipe, touch_path, text, button or press_key to use it; inspect lists labelled and clickable elements with their bounds. Also set_keyboard, rotate (orientation) and airplane_mode (enabled). Coordinates are screen pixels, the same as the screenshot.',
    schema: controlSchema(
      {
        device: str('attach: an adb serial such as emulator-5554 (default: the first emulator online)'),
        avd: str('attach: the name of a virtual device to start'),
        visible: { type: 'boolean', description: 'set_keyboard: show the on-screen keyboard' },
        orientation: {
          type: 'string',
          enum: ['portrait', 'landscape', 'reverse_portrait', 'reverse_landscape'],
          description: 'rotate: the orientation',
        },
        enabled: { type: 'boolean', description: 'airplane_mode: on or off' },
      },
      [...CONTROL_ACTIONS, 'airplane_mode'],
    ),
  },
  android_emulator_logs: {
    description: "Read the attached emulator's recent logcat lines (read) or its crash log (crash_report). Attach first.",
    schema: logsSchema({}),
  },
};

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {() => { simulatorIos?: boolean, simulatorAndroid?: boolean } | undefined} o.prefs the app's prefs (both switches default on)
 * @param {{ ios?: any, android?: any }} [o.drivers] replaces the real drivers
 * @param {(what: string, error: unknown) => void} [o.noteIgnored] records an error that is ignored on purpose
 * @returns {() => void} removes the tools
 */
function registerSimulatorTools(registry, o) {
  const exec = createExec();
  const drivers = {
    ios: o.drivers?.ios ?? createIos({ exec, noteIgnored: o.noteIgnored }),
    android: o.drivers?.android ?? createAndroid({ exec }),
  };
  const LABEL = { ios: 'iOS Simulator', android: 'Android Emulator' };
  /** Whether the platform's switch in Settings → General is off (both default on). */
  const turnedOff = (platform) => {
    const prefs = o.prefs();
    return platform === 'ios' ? prefs?.simulatorIos === false : prefs?.simulatorAndroid === false;
  };
  const add = (name, platform, kind) =>
    registry.register({
      name,
      description: SPECS[name].description,
      schema: SPECS[name].schema,
      policy: 'act',
      // the platform's switch in Settings is the consent; logs and screenshots read only a device the user can see
      authorizesItself: true,
      handler: async (args, ctx) => {
        if (turnedOff(platform)) throw new ToolError(`${LABEL[platform]} tools are turned off in Settings → General.`, 'disabled');
        const chatId = o.owner(ctx);
        if (!chatId) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        return drivers[platform][kind](chatId, args);
      },
    });
  const offs = [
    add('ios_simulator_control', 'ios', 'control'),
    add('ios_simulator_logs', 'ios', 'logs'),
    add('android_emulator_control', 'android', 'control'),
    add('android_emulator_logs', 'android', 'logs'),
  ];
  return () => offs.forEach((off) => off?.());
}

module.exports = { registerSimulatorTools, SPECS };
