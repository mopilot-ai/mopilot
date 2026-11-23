#!/usr/bin/env node
// Starts the bench's Chrome on a profile before browser use (VM only), through bench/scratch-chrome.mjs with MoPilot's extension loaded and pairing answered, and waits until the profile shows the extension on: MoPilot starts
// no Chrome for a profile that lacks it, and Chrome 155 drops it at every start (#1587).
// usage: node bench/bench-chrome.mjs <profile dir> [wait seconds=40] [fixture URL]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { MOPILOT_EXTENSION_ID, startOutcome, waitExtensionOn } from './lib/chromePipe.mjs';
import { requireVm } from './lib/guard.mjs';

requireVm('bench/bench-chrome.mjs');
const require = createRequire(import.meta.url);
const { chromeExecutable } = require('../electron/capabilities/browser/userChrome.cjs');
const { extensionInProfile } = require('../electron/capabilities/browser/chromeProfileExtension.cjs');
const [profile, waitS = '40', url, ...extra] = process.argv.slice(2);
if (!profile || extra.length || (url !== undefined && !/^https?:\/\//.test(url))) {
  console.error('usage: node bench/bench-chrome.mjs <profile dir> [wait seconds=40] [fixture URL]');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
const env = {
  ...process.env,
  MOPILOT_SCRATCH_CHROME_REAL: process.env.MOPILOT_SCRATCH_CHROME_REAL || chromeExecutable({ env: {} }),
  MOPILOT_SCRATCH_CHROME_EXTENSION: process.env.MOPILOT_SCRATCH_CHROME_EXTENSION || path.join(root, 'electron/chrome-extension'),
  MOPILOT_SCRATCH_CHROME_PAIR: '1',
};
const log = path.join(profile, 'scratch-chrome.log');
const size = () => (fs.existsSync(log) ? fs.statSync(log).size : 0);
const before = size();
// the wrapper outlives this script: it holds Chrome's pipe for as long as Chrome runs
spawn(
  process.execPath,
  [path.join(root, 'bench/scratch-chrome.mjs'), `--user-data-dir=${profile}`, '--no-first-run', ...(url ? [url] : ['--no-startup-window'])],
  {
    env,
    detached: true,
    stdio: 'ignore',
  },
).unref();
try {
  // this start's own word first: the preferences still list an extension the last Chrome loaded before it quit
  const said = () => {
    if (!fs.existsSync(log)) return null;
    const fd = fs.openSync(log, 'r');
    const buf = Buffer.alloc(Math.max(0, size() - before));
    fs.readSync(fd, buf, 0, buf.length, before);
    fs.closeSync(fd);
    return startOutcome(buf.toString('utf8'));
  };
  const end = Date.now() + Number(waitS) * 1000;
  let outcome = said();
  while (!outcome && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 500));
    outcome = said();
  }
  if (!outcome) throw new Error(`the wrapper said nothing about the extension in ${waitS} s`);
  if (outcome.outcome === 'failed') throw new Error(outcome.line);
  const ms = await waitExtensionOn(() => extensionInProfile(MOPILOT_EXTENSION_ID, { userData: profile }), { waitMs: Number(waitS) * 1000 });
  console.log(`MoPilot's extension is on in ${profile} (${outcome.line.replace(/^\S+ /, '')}; the profile shows it ${ms} ms later)`);
} catch (e) {
  console.error(
    `${/** @type {Error} */ (e).message}\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').slice(-5).join('\n') : ''}`,
  );
  process.exit(1);
}
