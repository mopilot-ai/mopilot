#!/usr/bin/env node
// The Chrome a harness version contract instance starts (its MOPILOT_CHROME_RELAY_EXECUTABLE): refuses one without its
// own --user-data-dir, since the benchmark VM's default Chrome profile is a real, signed-in and synced one; otherwise
// runs the Chrome the run named (MOPILOT_SCRATCH_CHROME_REAL) with the same arguments. With
// MOPILOT_SCRATCH_CHROME_EXTENSION it loads MoPilot's extension from that folder into the Chrome it starts before
// opening any page, and quits that Chrome (exit 3) when the extension does not run: browser use would fail without it,
// silently. With MOPILOT_SCRATCH_CHROME_PAIR=1 it presses Pair on MoPilot's pairing pages, as the bench's operator.
// Each outcome is appended to <user-data-dir>/scratch-chrome.log (MoPilot starts this with no stdio).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { autoPair, loadExtension, PIPE_STDIO, pipeClient, pipeLaunch, runningOn, userDataDirOf } from './lib/chromePipe.mjs';
import { chromeGuard } from './lib/contract.mjs';

const args = process.argv.slice(2);
const g = chromeGuard(args, process.env);
if ('refuse' in g) {
  console.error(g.refuse);
  process.exit(2);
}
const profile = /** @type {string} */ (userDataDirOf(args));
const note = (/** @type {string} */ line) => {
  console.error(`scratch-chrome: ${line}`);
  try {
    fs.mkdirSync(profile, { recursive: true });
    fs.appendFileSync(path.join(profile, 'scratch-chrome.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // the note still went to stderr
  }
};
// a Chrome already on this profile takes the start over: it gets the URLs as they are, and keeps its own extension
const pipe = !!g.extension && !runningOn(profile);
if (g.extension && !pipe)
  note('a Chrome already runs on this profile: handing the start over to it (it loaded the extension when it started)');
const launch = pipe ? pipeLaunch(args) : { args, urls: [] };
let failed = false;
const chrome = spawn(g.chrome, launch.args, { stdio: pipe ? [...PIPE_STDIO] : 'inherit' });
chrome.on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});
chrome.on('exit', (code) => process.exit(failed ? 3 : (code ?? 1)));
if (pipe) {
  const [, , , toChrome, fromChrome] = /** @type {any[]} */ (chrome.stdio);
  const client = pipeClient(toChrome, fromChrome);
  loadExtension(client, /** @type {string} */ (g.extension)).then(
    async (r) => {
      note(`MoPilot's extension ${r.id} runs (${r.ms} ms after loading)`);
      try {
        // the operator's Pair on each pairing page, from now on (a bench run has no person to press it)
        if (g.pair) await autoPair(client, { report: note });
        for (const url of launch.urls) await client.send('Target.createTarget', { url });
      } catch (e) {
        // the extension runs; a page it was asked to open, or pairing, says what went wrong
        note(`after loading the extension: ${/** @type {Error} */ (e).message}`);
      }
    },
    (e) => {
      failed = true;
      note(`${e.message}. Quitting this Chrome: browser use needs the extension.`);
      chrome.kill();
    },
  );
}
