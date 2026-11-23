// Renders the DMG window's background, build/dmg/background.html, to build/dmg/background.png (600 × 400) and
// background@2x.png (1200 × 800) with Playwright's Chromium; scripts/dmg.mjs puts them in the DMG (dmgbuild joins
// the pair into one HiDPI image). Run after editing the HTML; the outputs are committed:
//   node scripts/make-dmg-background.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

export const DMG_DIR = fileURLToPath(new URL('../build/dmg/', import.meta.url));
export const SIZE = { width: 600, height: 400 };

/** Renders the background at 1x and 2x. `launch` starts a Chromium (Playwright's by default). Returns the files written. */
export async function makeDmgBackground({ dir = DMG_DIR, launch = () => chromium.launch(), log = console.log } = {}) {
  const browser = await launch();
  const written = [];
  try {
    for (const { scale, name } of [
      { scale: 1, name: 'background.png' },
      { scale: 2, name: 'background@2x.png' },
    ]) {
      const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: scale });
      await page.goto(pathToFileURL(path.join(dir, 'background.html')).href);
      // the web font must be in before the shot, or Chromium draws the fallback
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(dir, name);
      await page.screenshot({ path: file });
      await page.close();
      written.push(file);
      log('Wrote', file);
    }
  } finally {
    await browser.close();
  }
  return written;
}

/** The command line. Returns the exit code. */
export async function main(argv, { make = makeDmgBackground, log = console.log, error = console.error } = {}) {
  if (argv.includes('--help')) {
    log('usage: node scripts/make-dmg-background.mjs   (renders build/dmg/background.html to its PNGs)');
    return 0;
  }
  try {
    await make();
    return 0;
  } catch (e) {
    error(e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
