// DEV ONLY: how each phone gate takes its raw samples from a device through WebDriverAgent and the dev host; every dependency (the driver, the shell, the clock, the operator's Enter key) is passed in, so the maths and the flow are tested without a phone.
import { CORE_SCREENS, CRITICAL_AUDIT_TYPES, criticalCount, hitchRatio, stepSamples } from './stats.mjs';

/** A tap on the id only ("Settings" the button, not a sentence that has the word); the driver's tap takes it, its typings only name the timeout. */
const EXACT = /** @type {any} */ ({ exact: true });

/** The owner's own app: never driven by a gate. */
export const OWNER_BUNDLE_ID = 'ai.mopilot.phone';
/** The owner's app under its earlier id (TestFlight builds 2–12), still installed on phones: refused too. */
const EARLIER_OWNER_BUNDLE_ID = 'ai.mopilot.remote';

/** The one place a bundle id is accepted: a gate runs on a separate build, never on the owner's app. @param {string | undefined} id */
export function checkBundleId(id) {
  if (!id) throw new Error('give --bundle-id of a separate build (for example ai.mopilot.phone.dev)');
  if (id === OWNER_BUNDLE_ID || id === EARLIER_OWNER_BUNDLE_ID)
    throw new Error(`${id} is the owner's app: a gate never runs on it; use a separate bundle id`);
  return id;
}

/** Every label of Settings › About, then back to the chats list. @param {import('../mobile-ios-journey/wda.mjs').Wda} wda */
export async function readAbout(wda) {
  await wda.tap('Open menu');
  await wda.tap('Settings', EXACT);
  await wda.tap('About');
  const labels = await wda.labels();
  await wda.tap('Back', EXACT);
  await wda.tap('Close', EXACT);
  return labels;
}

/**
 * Warm launch to the chat list: the app is ended, WebDriverAgent starts it again with a new session, and its own `list-shown` signpost (ms after the app began) is read from About.
 * @param {{ wda: any, terminate: () => Promise<void>, count?: number }} o
 */
export async function runLaunch({ wda, terminate, count = 10 }) {
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    await terminate();
    await wda.open();
    await wda.waitFor('Open menu');
    const [shown] = stepSamples(await readAbout(wda), 'list-shown');
    if (shown === undefined) throw new Error('About shows no list-shown signpost for this launch');
    samples.push(shown);
  }
  return {
    samples,
    notes: ['signpost list-shown, ms after the app began; the process was ended before each launch'],
  };
}

/**
 * Cached chat open: `count + 1` opens of one chat (the first fills the cache and is dropped by About's own ten-row memory); the `rows-shown` signpost of each is read once at the end.
 * @param {{ wda: any, chat: string, count?: number }} o
 */
export async function runChatOpen({ wda, chat, count = 10 }) {
  for (let i = 0; i <= count; i += 1) {
    await wda.tap(`Open chat ${chat}`);
    await wda.waitFor('Back to chats');
    await wda.tap('Back to chats', EXACT);
    await wda.waitFor('Open menu');
  }
  const samples = stepSamples(await readAbout(wda), 'rows-shown').slice(0, count);
  return {
    samples,
    notes: [`signpost rows-shown of "${chat}", ms after the tap; ${count + 1} opens, the first fills the cache`],
  };
}

/**
 * Frame arrival times (ms) of WebDriverAgent's MJPEG stream: one per `--BoundaryString`, however the chunks cut it.
 * @param {AsyncIterable<Uint8Array>} stream @param {() => number} now
 */
export async function mjpegFrameTimes(stream, now) {
  const marker = Buffer.from('--BoundaryString');
  /** @type {number[]} */
  const times = [];
  let tail = Buffer.alloc(0);
  for await (const chunk of stream) {
    const seen = now();
    const data = Buffer.concat([tail, chunk]);
    let from = 0;
    for (let at = data.indexOf(marker, from); at !== -1; at = data.indexOf(marker, from)) {
      times.push(seen);
      from = at + marker.length;
    }
    // a marker cut by the end of this chunk starts in the last bytes of it
    tail = data.subarray(Math.max(from, data.length - (marker.length - 1)));
  }
  return times;
}

/**
 * Hitch ratio of a 60 s stream: per sample the operator's command starts the dev host's synthetic stream and the screen's frames are captured meanwhile.
 * The frames are the screen recording's (WebDriverAgent's MJPEG), a proxy for what the display drew; an Animation Hitches trace can be supplied instead as frame times.
 * @param {{ startStream: () => Promise<void>, capture: () => Promise<number[]>, count?: number }} o
 */
export async function runHitch({ startStream, capture, count = 10 }) {
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    await startStream();
    samples.push(hitchRatio(await capture()));
  }
  return {
    samples,
    notes: ['frames from WebDriverAgent MJPEG while the synthetic stream ran; a proxy for display hitches'],
  };
}

/**
 * Half-open link detection: the dev host is frozen (SIGSTOP: its sockets stay open and nothing comes back), and the time until the computer no longer reads "Connected" is taken.
 * The resolution is one WebDriverAgent lookup (a few hundred ms), so a result close to the limit needs a trace to settle it.
 * @param {{ wda: any, freeze: () => void, thaw: () => void, now: () => number, label?: string, count?: number }} o
 */
export async function runHalfOpen({ wda, freeze, thaw, now, label = ', Connected', count = 10 }) {
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    await wda.waitFor(label, { timeoutMs: 60_000 });
    const began = now();
    freeze();
    try {
      await wda.waitGone(label, { timeoutMs: 30_000, intervalMs: 50 });
      samples.push(now() - began);
    } finally {
      thaw();
    }
  }
  return {
    samples,
    notes: [`time from freezing the host until no "${label}" is on screen; resolution is one lookup`],
  };
}

/**
 * Notification to decision with no app open: a stopwatch protocol, because nothing can drive the lock screen.
 * The operator makes the dev host ask for an approval, locks the phone, presses Enter when the notification shows and again when the answer has been sent.
 * @param {{ ask: (prompt: string) => Promise<void>, now: () => number, count?: number }} o
 */
export async function runDecision({ ask, now, count = 10 }) {
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    await ask(
      `Sample ${i + 1}/${count}: make the dev host ask for an approval, lock the phone. Press Enter at the moment the notification shows.`,
    );
    const began = now();
    await ask('Decide it from the notification or the lock screen, then press Enter when the Mac has the answer.');
    samples.push(now() - began);
  }
  return {
    samples,
    notes: ["operator stopwatch; includes the operator's reaction time at the second Enter"],
  };
}

/**
 * Accessibility audit of each core screen: the operator shows a screen, the audit runs on the app in front, and its critical findings are counted.
 * @param {{ ask: (prompt: string) => Promise<void>, audit: () => Promise<{ auditType?: string, compactDescription?: string }[]>, screens?: string[] }} o
 */
export async function runA11y({ ask, audit, screens = CORE_SCREENS }) {
  /** @type {number[]} */
  const samples = [];
  /** @type {string[]} */
  const notes = [`critical audit types: ${CRITICAL_AUDIT_TYPES.join(', ')}`];
  for (const screen of screens) {
    await ask(`Show the "${screen}" screen, then press Enter.`);
    const issues = await audit();
    const critical = criticalCount(issues);
    samples.push(critical);
    for (const issue of issues) notes.push(`${screen}: ${issue.auditType ?? 'unknown'}: ${issue.compactDescription ?? ''}`);
  }
  return { samples, notes };
}
