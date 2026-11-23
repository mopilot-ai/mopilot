// DEV ONLY: takes the App Store screenshots of the phone app's key screens through the WebDriverAgent runner (scripts/mobile-ios-wda.sh) on a plugged-in iPhone showing the dev host's seeded chats: `node scripts/store-screenshots.mjs --wda http://[tunnel address]:8100 [--plan store/screenshots.json] [--out store/screenshots]`, run as `npm run screenshots`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pngInfo } from './png.mjs';

const MOBILE = fileURLToPath(new URL('..', import.meta.url));
/** The only app this script may drive: the runner can tap anything on the phone. */
export const BUNDLE_ID = 'ai.mopilot.phone';
/**
 * Pixel sizes App Store Connect takes for an iPhone screenshot (portrait), by display class. From Apple's published list at the time of
 * writing; App Store Connect says which sizes it accepts when you upload, and a size missing here means this table is out of date.
 */
export const SIZES = {
  'iphone-6.9': ['1320x2868', '1290x2796', '1260x2736'],
  'iphone-6.5': ['1284x2778', '1242x2688'],
  'iphone-6.3': ['1206x2622', '1179x2556'],
  'iphone-6.1': ['1125x2436', '1170x2532', '1080x2340'],
};
/**
 * The only labels this tour taps: navigation to screens it reads. An allow-list, because a deny-list misses a verb: a label is matched
 * from its start, so "Chats, 2 need you" is "Chats".
 */
const NAVIGATION = /^(chats|momo|settings|changes|files|terminal|live view|notifications|about|memory|routines|home|back|close)\b/i;

/** @param {unknown} plan @returns {{ screens: { name: string, steps: ({ tap: string } | { wait: number } | { home: true })[] }[] }} */
export function validatePlan(plan) {
  const p = /** @type {any} */ (plan);
  if (p?.bundleId !== BUNDLE_ID) throw new Error(`the plan must drive ${BUNDLE_ID} only, got ${JSON.stringify(p?.bundleId)}`);
  if (!Array.isArray(p.screens) || !p.screens.length) throw new Error('the plan has no screens');
  const names = new Set();
  for (const screen of p.screens) {
    if (!/^[a-z0-9-]+$/.test(screen?.name ?? '') || names.has(screen.name)) throw new Error(`screen names must be unique lowercase words, got ${JSON.stringify(screen?.name)}`);
    names.add(screen.name);
    for (const step of screen.steps ?? []) {
      if ('tap' in step && !NAVIGATION.test(step.tap)) throw new Error(`${screen.name}: this tour taps navigation labels only (${NAVIGATION.source.slice(2, -3)}), not "${step.tap}"`);
      if (!('tap' in step || 'wait' in step || 'home' in step)) throw new Error(`${screen.name}: a step is tap, wait or home`);
    }
  }
  return p;
}

/** The folder names whose accepted sizes include this screenshot. */
export function classify(width, height) {
  return Object.entries(SIZES).filter(([, sizes]) => sizes.includes(`${width}x${height}`)).map(([name]) => name);
}

/**
 * @param {string[]} argv
 * @param {{ fetch?: typeof fetch, out?: (line: string) => void, sleep?: (ms: number) => Promise<void>, root?: string }} [io]
 * @returns {Promise<number>} the exit status
 */
export async function main(argv, { fetch: call = fetch, out = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), root = MOBILE } = {}) {
  const { values } = parseArgs({ args: argv, options: { wda: { type: 'string' }, plan: { type: 'string', default: 'store/screenshots.json' }, out: { type: 'string', default: 'store/screenshots' } } });
  if (!values.wda) {
    out('usage: store-screenshots.mjs --wda http://[tunnel address]:8100 [--plan store/screenshots.json] [--out store/screenshots]');
    return 2;
  }
  try {
    const plan = validatePlan(JSON.parse(readFileSync(join(root, values.plan), 'utf8')));
    const base = values.wda.replace(/\/$/, '');
    const wda = async (method, path, body) => {
      const response = await call(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${json?.value?.message ?? response.status}`), { status: response.status });
      return json.value;
    };
    const created = await wda('POST', '/session', { capabilities: { alwaysMatch: { bundleId: BUNDLE_ID } } });
    const session = `/session/${created.sessionId ?? created?.capabilities?.sessionId}`;
    let index = 0;
    for (const screen of plan.screens) {
      for (const step of screen.steps) {
        if ('home' in step) {
          await wda('POST', `${session}/wda/apps/terminate`, { bundleId: BUNDLE_ID });
          await wda('POST', `${session}/wda/apps/launch`, { bundleId: BUNDLE_ID });
          await sleep(2000);
        } else if ('wait' in step) await sleep(step.wait * 1000);
        else {
          const label = step.tap.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          // from the start of the label, so a badge ("Chats, 2 need you") does not hide the control
          const found = await wda('POST', `${session}/element`, { using: '-ios predicate string', value: `label BEGINSWITH "${label}"` }).catch((error) => {
            if (error.status === 404 || /no such element/i.test(error.message)) return null;
            throw error;
          });
          const id = found?.ELEMENT ?? found?.['element-6066-11e4-a52e-4f735466cecf'];
          if (!id) throw new Error(`${screen.name}: no element labelled "${step.tap}" on the screen; the plan's labels follow the UI, update ${values.plan}`);
          await wda('POST', `${session}/element/${id}/click`, {});
          await sleep(800);
          // a tap that opened a system sheet or another app would send the next tap there
          const front = await wda('GET', `${session}/wda/activeAppInfo`);
          if (front?.bundleId !== BUNDLE_ID) throw new Error(`${screen.name}: after tapping "${step.tap}" ${front?.bundleId ?? 'another app'} is in front, not ${BUNDLE_ID}`);
        }
      }
      const png = Buffer.from(await wda('GET', `${session}/screenshot`), 'base64');
      let info;
      try {
        info = pngInfo(png);
      } catch {
        throw new Error(`${screen.name}: the runner did not return a PNG`);
      }
      const { width, height, colorType } = info;
      const classes = classify(width, height);
      if (!classes.length) throw new Error(`${screen.name}: ${width}x${height} is not a size App Store Connect accepts for an iPhone screenshot (see mobile/assets/README.md)`);
      // the phone's own size decides the folder
      const dir = join(root, values.out, classes[0]);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${String(++index).padStart(2, '0')}-${screen.name}.png`);
      writeFileSync(file, png);
      out(`${file} ${width}x${height} (accepted as ${classes.join(', ')})${colorType === 6 ? ' has an alpha channel: export it without before uploading' : ''}`);
    }
    return 0;
  } catch (error) {
    out(`store-screenshots: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
