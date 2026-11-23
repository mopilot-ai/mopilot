// scripts/host-app-launch.cjs and the hook's use of it: commands that start MoPilot on this computer are recognised and refused; unit tests, ordinary scripts and the VM and CI runners are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { launchesAppHere, HOST_APP_REASON } = require('../scripts/host-app-launch.cjs');
const { startsHostApp, startsReleaseSuite, claudeHookDecision } = require('../scripts/release-suites.cjs');

const call = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
const desktop = () => false;

test('a dev, test or built instance started here is recognised, however the command reaches it', () => {
  for (const command of [
    // the dev setup and the app's start script
    'npm run dev',
    'npm start',
    'npm run start',
    'npm run -s dev',
    'npm --prefix . run dev',
    'yarn dev',
    'pnpm run start',
    'node scripts/dev.mjs',
    'node ./scripts/dev.mjs --inspect',
    'SAGE_DEV_PORT=5771 SAGE_DEBUG_PORT=9571 npm run dev',
    // Electron from node_modules, through npx or a wrapper, or the built package's binary
    'electron .',
    'npx electron . --remote-debugging-port=9371',
    'npx --yes electron@44.7.0 .',
    'nohup ./node_modules/.bin/electron . > /tmp/sage-dev-app.log 2>&1 < /dev/null & disown',
    '"./node_modules/.bin/electron" . --remote-debugging-port=9400',
    'env -i PATH=/usr/bin node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
    'cd ~/mopilot && vite build && electron .',
    '"out/MoPilot-darwin-arm64/MoPilot.app/Contents/MacOS/MoPilot" --remote-debugging-port=9500',
    '/Applications/MoPilot\\ Code.app/Contents/MacOS/MoPilot\\ Code --remote-debugging-port=9500',
    // a test instance's switches, whatever starts it
    'SAGE_E2E_BACKGROUND=1 MOPILOT_USER_DATA=/tmp/s ./launch.sh',
    'MOPILOT_TEST_RUN=r1 make app',
    'export SAGE_E2E_BACKGROUND=1; ./launch.sh',
    // a built package or the app by name
    'open "out/MoPilot-darwin-arm64/MoPilot.app"',
    'open -a "MoPilot" --args --remote-debugging-port=9500',
    'open -n -b ai.mopilot.code',
    'open -n "/Applications/MoPilot.app"',
    'open "/Applications/MoPilot.app" --args --remote-debugging-port=9500',
    // text handed to another shell, or substituted, is code
    'zsh -lc "cd ~/mopilot && npm run dev"',
    "bash -c 'electron .'",
    'echo $(npm start)',
    'echo `npm run dev`',
    "sh <<'EOF'\nnpm run dev\nEOF",
    'cd x\nbash -s <<EOF\nelectron .\nEOF',
    'echo "started: $(npm start)"',
    "eval 'npm run dev'",
    // wrappers, a pipe into a shell, a cd back out of the portal, other ways to name Electron or open
    'nice -n 10 npm run dev',
    'timeout 600 electron .',
    'arch -arm64 ./node_modules/.bin/electron .',
    'sudo -u me electron .',
    'env -u FOO electron .',
    "echo 'npm run dev' | bash",
    "printf 'electron .\\n' | /bin/zsh -s",
    'cd web && npm run build; cd .. && npm run dev',
    'npm exec electron -- .',
    'npm x --yes electron .',
    'yarn electron .',
    '/usr/bin/open -n "out/MoPilot-darwin-arm64/MoPilot.app"',
  ]) {
    assert.equal(startsHostApp(command), true, command);
    assert.equal(claudeHookDecision(call(command), {}, desktop)?.hookSpecificOutput.permissionDecisionReason, HOST_APP_REASON, command);
  }
});

test('unit tests, ordinary scripts, the portal and text that only names a launch are let through', () => {
  for (const command of [
    'npm test',
    'npm ci',
    'npm run test:coverage -- --changed --related',
    'npm run test:related -- scripts/dev.mjs electron/main.cjs',
    'npm run build',
    'npm run dev:docs',
    'npm run lint -- --start',
    'npm',
    'npm ls electron',
    'node node_modules/electron/install.js',
    'node scripts/test-chats.mjs folder --run r1',
    'node',
    'ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "console.log(1)"',
    'npx electron-builder --mac',
    'npx',
    'npx --yes',
    'npx tsc --noEmit',
    'cat scripts/dev.mjs electron/main.cjs',
    'grep -rn SAGE_E2E_BACKGROUND= docs',
    'echo $MOPILOT_TEST_RUN',
    'ls electron/',
    'cd web && npm run dev',
    'npm --prefix web run start',
    'cd ~/mopilot/web && npm run dev',
    "echo 'npm test' | bash",
    'npm exec biome -- check',
    'open "/Applications/MoPilot.app"',
    'open /Applications/MoPilot.app',
    'open "/Applications/MoPilot Code.app"',
    'open /Applications/MoPilot\\ Code.app',
    'open https://github.com/mopilot-ai/mopilot-internal/pull/1',
    'open docs/report.html',
    'open',
    "git commit -m 'Refuse npm run dev and electron . on the host'",
    "gh pr create --body-file - <<'EOF'\nnpm run dev, SAGE_E2E_BACKGROUND=1 electron . were not run.\nEOF",
    '',
    '   ',
    // a shell given text with no launch in it
    'bash -c "npm test"',
    'npx electron --version',
    './node_modules/.bin/electron -v',
    // quoted arguments that only name a launch, beside a substitution
    'for p in $(pgrep -f "wt/node_modules/electron"); do kill $p; done',
    "grep -E '^\\| `(electron|shared)/' docs/module-map.md",
    'echo "$(cat notes.md)" "npm run dev"',
    'git commit -m "$(cat <<\'EOF\'\nRefuse a launch on the host\n\nnpm run dev\nelectron .\nEOF\n)"',
    "cat > body.md <<'EOF'\nRun `npm run dev` with $(date)\nEOF",
  ]) {
    assert.equal(startsHostApp(command), false, command);
    assert.equal(claudeHookDecision(call(command), {}, desktop), null, command);
  }
});

test('the virtual machine and the CI runners may start the app; a release session skips the hook', () => {
  for (const command of [
    'scripts/vm-exec.sh zsh -lc "cd ~/mopilot && SAGE_E2E_BACKGROUND=1 npm run dev"',
    'scripts/vm-exec.sh electron .',
    "node scripts/ci-cuj.mjs --branch my-fix --spec 'cuj-claude*'",
  ]) {
    assert.equal(startsHostApp(command), false, command);
    assert.equal(claudeHookDecision(call(command), {}, desktop), null, command);
  }
  // anything after the hand-off still runs here
  assert.equal(startsHostApp('scripts/vm-exec.sh true; npm run dev'), true);
  assert.equal(claudeHookDecision(call('npm run dev'), { MOPILOT_RELEASE: '1' }), null);
  assert.equal(
    claudeHookDecision(call('npm run dev'), {}, () => true),
    null,
  );
});

test('a release-only suite keeps its own reason; the host-launch reason points at the runners, the VM and the user', () => {
  assert.equal(startsReleaseSuite('node scripts/motion-cdp/run.mjs --out /tmp/m'), true);
  assert.match(
    claudeHookDecision(call('SAGE_E2E_BACKGROUND=1 npx playwright test -c tests/e2e'), {}, desktop).hookSpecificOutput
      .permissionDecisionReason,
    /release-only suite/,
  );
  for (const part of [
    'node scripts/ci-cuj.mjs --branch <b> --spec',
    'scripts/vm-exec.sh <command>',
    'ask the user',
    'give them the command',
  ])
    assert.ok(HOST_APP_REASON.includes(part), part);
  // the module reads nested shell text only when the caller says the command hands it to a shell
  assert.equal(launchesAppHere('zsh -lc "npm run dev"', /^$/), false);
  assert.equal(launchesAppHere('zsh -lc "npm run dev"', /zsh/), true);
});
