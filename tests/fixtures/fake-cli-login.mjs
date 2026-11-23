// A stand-in for the vendor CLIs' login commands: prints what the real ones print and ends as FAKE_CLI_MODE says.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.env.FAKE_CLI_MODE ?? 'ok';
const say = (line) => process.stdout.write(`${line}\n`);

if (mode === 'tree') {
  const child = spawn(process.execPath, [import.meta.filename], {
    stdio: 'inherit',
    env: { ...process.env, FAKE_CLI_MODE: 'ignore-stop' },
  });
  fs.writeFileSync(process.env.FAKE_CLI_OUT, String(child.pid));
} else if (mode === 'delayed-stop' || mode === 'ignore-stop') {
  process.on('SIGTERM', () => {
    if (mode === 'delayed-stop') setTimeout(() => process.exit(0), 150);
  });
  say('! First copy your one-time code: ABCD-1234');
  say('Open this URL to continue in your web browser: https://github.com/login/device');
  setInterval(() => undefined, 1000);
} else if (mode.startsWith('github') && process.argv[3] !== 'login') {
  process.exitCode = 0;
} else if (mode === 'github-legacy' && process.argv.includes('--clipboard=false')) {
  process.stderr.write('unknown flag: --clipboard\n\nAuthenticate with a GitHub host.\n');
  process.exitCode = 1;
} else if (mode.startsWith('github')) {
  const output = mode === 'github-fail' ? process.stdout : process.stderr;
  if (mode === 'github' && !process.argv.includes('--clipboard=false')) {
    process.stderr.write('! Failed to copy one-time code to clipboard\n  No clipboard utilities available.\n');
  }
  output.write('Unrelated output with reference REF1-INFO\n');
  output.write('! First copy your one-time code: \x1b[1mABCD-1234\x1b[0m\r\n');
  output.write('Open this URL to continue in your web browser: https://github.com/');
  setTimeout(() => output.write('login/device\n'), 10);
  setTimeout(() => {
    output.write('unsafe https://github.com/login/device?token=private-secret\n');
    if (mode === 'github-fail') process.stderr.write('unknown flag: --clipboard\n');
    process.exitCode = mode === 'github-fail' ? 1 : 0;
  }, 50);
} else if (mode === 'ok') {
  say('Open https://auth.example.com/device and enter the code ABCD-1234.');
  say('');
  process.stderr.write('waiting for approval\n');
  setTimeout(() => process.exit(0), 50);
} else if (mode === 'codex-color') {
  // what `codex login --device-auth` 0.171 prints to a pipe, colors and all
  say('');
  say('Welcome to Codex [v\x1b[90m0.171.0\x1b[0m]');
  say('Follow these steps to sign in with ChatGPT using device code authorization:');
  say('');
  say('1. Open this link in your browser and sign in to your account');
  say('   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m');
  say('');
  say('2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m');
  say('   \x1b[94mABCD-EFGHI\x1b[0m');
  setTimeout(() => process.exit(0), 50);
} else if (mode === 'color-fail') {
  process.stderr.write('\x1b[31mError:\x1b[0m login was refused\n');
  process.exit(1);
} else if (mode === 'nonl') {
  process.stdout.write('visit https://auth.example.com/last');
  process.exit(0);
} else if (mode === 'input') {
  say('Paste the code from https://auth.example.com/paste here:');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (text) => {
    fs.writeFileSync(process.env.FAKE_CLI_OUT, text);
    process.exit(0);
  });
} else if (mode === 'fail') {
  for (const n of [1, 2, 3, 4, 5]) process.stderr.write(`step ${n}\n`);
  process.stderr.write('Login failed: the code was refused\n');
  process.exit(3);
} else if (mode === 'silent') {
  process.exit(2);
} else {
  // 'hang': prints its link and waits to be stopped
  say('Open https://auth.example.com/hang');
  setInterval(() => undefined, 1000);
}
