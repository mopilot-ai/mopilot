#!/usr/bin/env node
// A stand-in for `npm install --global --prefix <dir> <spec>` in the Host's agent install tests: FAKE_NPM_MODE says how it behaves, FAKE_NPM_LOG records each run (args, start, end), FAKE_NPM_ONLY limits the mode to one package, FAKE_NPM_BIN names the binary an install puts in <prefix>/bin.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
// FAKE_NPM_ONLY: the mode applies to that package only, any other installs fine
const only = process.env.FAKE_NPM_ONLY;
const mode = only && !args.at(-1).includes(only) ? 'ok' : (process.env.FAKE_NPM_MODE ?? 'ok');
const log = process.env.FAKE_NPM_LOG;
const bin = process.env.FAKE_NPM_BIN ?? 'codex';
const note = (what) => log && fs.appendFileSync(log, `${JSON.stringify({ what, args, at: Date.now() })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Observing start also means the stubborn process is ready to handle cancellation.
if (mode === 'stubborn') process.on('SIGTERM', () => note('term'));
note('start');
const put = (body) => {
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', bin), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
};

if (mode === 'ok' || mode === 'slow') {
  if (mode === 'slow') await sleep(Number(process.env.FAKE_NPM_MS ?? 300));
  process.stdout.write('\nadded 1 package in 1s\r\n');
  put("if (process.argv[2] === '--version') console.log('1.2.3 (fake)');");
} else if (mode === 'netfail') {
  process.stderr.write(
    'npm error code ENOTFOUND\nnpm error network request to https://user:secret@registry.example/x failed, reason: getaddrinfo ENOTFOUND\nnpm error A complete log of this run can be found in: /x.log\n',
  );
  process.exitCode = 1;
} else if (mode === 'generic') {
  process.stderr.write(
    'npm error code EBADENGINE\nnpm error engine Unsupported engine\nnpm error //registry.example/:_authToken=abc123\nnpm error\n',
  );
  process.exitCode = 1;
} else if (mode === 'silent-fail') {
  process.exitCode = 3;
} else if (mode === 'nobin') {
  process.stdout.write('up to date in 1s\n');
} else if (mode === 'badbin') {
  put("console.error('Error: Cannot find module @openai/codex-darwin-arm64'); process.exit(1);");
} else if (mode === 'hangbin') {
  put('setTimeout(() => undefined, 60_000);');
} else if (mode === 'chatty') {
  for (let i = 1; i <= 60; i++) process.stderr.write(`npm error line ${i}\n`);
  process.exitCode = 1;
} else if (mode === 'nonexec') {
  put('');
  fs.chmodSync(path.join(prefix, 'bin', bin), 0o644);
} else if (mode === 'mutebin') {
  put('process.exit(2);');
} else if (mode === 'quietbin') {
  put('');
} else if (mode === 'stubborn') {
  // npm on SIGTERM keeps writing its tree for a while: this one never stops by itself
  await sleep(60_000);
} else if (mode === 'hang') {
  process.stdout.write('reify: timing\n');
  await sleep(60_000);
}
note('end');
