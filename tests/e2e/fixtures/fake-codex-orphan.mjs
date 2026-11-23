#!/usr/bin/env node
// fake-codex.mjs, plus a long command it leaves orphaned, for the Windows containment check (scripts/win-containment.mjs):
// `app-server` starts a command through a launcher that exits at once, so its parent is gone and no process-tree walk
// reaches it (only the Job Object MoPilot holds the harness in does), and writes the command's pid to
// $FAKE_CODEX_ORPHAN_PID. It starts it a few seconds in, after MoPilot has held the harness, as a real harness's
// commands start with a turn. With $FAKE_CODEX_ORPHAN_EXIT=1 the app-server then exits, as a harness that crashes does.
// Only the first app-server does this (the pid file is its marker), so a restart after that exit runs plain fake-codex.
import fs from 'node:fs';
import { startOrphan } from '../../../scripts/win-containment.mjs';

const PID_FILE = process.env.FAKE_CODEX_ORPHAN_PID;
const START_AFTER_MS = 4000;
const EXIT_AFTER_MS = 2000;

if (process.argv[2] === 'app-server' && PID_FILE && !fs.existsSync(PID_FILE)) {
  fs.writeFileSync(PID_FILE, '');
  setTimeout(() => {
    fs.writeFileSync(PID_FILE, `${startOrphan()}\n`);
    if (process.env.FAKE_CODEX_ORPHAN_EXIT === '1') setTimeout(() => process.exit(3), EXIT_AFTER_MS);
  }, START_AFTER_MS);
}

await import('./fake-codex.mjs');
