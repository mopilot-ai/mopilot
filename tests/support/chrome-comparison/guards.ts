// guards Chrome comparison cases using shared fake drivers and page services.
import {
  test,
  assert,
  spawnSync,
  fs,
  os,
  path,
  TASKS,
  selectTasks,
  ARMS,
  HARNESSES,
  chromeHomes,
  canonical,
  parseArgs,
  refusal,
  otherChromes,
  runComparison,
  psCommands,
  importModule,
  insideVirtualMachine,
  fakeDriver,
} from './fixture.ts';

export function registerGuards() {
  test('run: options, and the guards: release-only, a scratch profile that is no Chrome home, an app to launch', () => {
    const o = parseArgs([
      '--arms=b2,b1',
      '--harnesses',
      'claude',
      '--tasks=spa,dialog',
      '--optional',
      '--repeat',
      '3',
      '--user-data-dir',
      '/tmp/scratch',
      '--app=/src/app',
      '--out',
      '/tmp/out',
      '--timeout=90',
      '--model',
      'claude=Sonnet 5.5',
      '--model=codex=GPT-6 Luna',
      '--effort=low',
    ]);
    assert.deepEqual(o, {
      arms: ['b2', 'b1'],
      harnesses: ['claude'],
      tasks: ['spa', 'dialog'],
      optional: true,
      repeat: 3,
      userDataDir: '/tmp/scratch',
      app: '/src/app',
      out: '/tmp/out',
      timeoutMs: 90_000,
      models: { claude: 'Sonnet 5.5', codex: 'GPT-6 Luna' },
      effort: 'low',
      probe: null,
      flags: '',
    });
    const d = parseArgs(['--repeat=x', '--timeout=x', '--effort= ']);
    assert.deepEqual(
      [d.arms, d.harnesses, d.repeat, d.timeoutMs, d.tasks, d.models, d.effort],
      [['native', 'ext', 'b2', 'b1'], ['claude', 'codex'], 1, 600_000, null, {}, null],
    );
    // the shipped arm and opencode only when asked for (#1483)
    assert.equal(ARMS.shipped.optional, true);
    // the plugin arm (#1539): the chrome_* tools off, so a Codex chat's plugin drives MoPilot's extension
    assert.deepEqual(ARMS.plugin, {
      flags: 'native.claude.chrome=0,shared.browser.chromeExtensionByDefault=0',
      channel: 'builtin',
      ownChrome: true,
      optional: true,
    });
    assert.deepEqual(parseArgs(['--arms=plugin']).arms, ['plugin']);
    assert.deepEqual(parseArgs(['--arms=shipped', '--harnesses=opencode', '--model=opencode=Big Pickle']).harnesses, ['opencode']);
    assert.deepEqual([...HARNESSES], ['claude', 'codex', 'opencode']);
    assert.throws(() => parseArgs(['--model=claude']), /--model takes harness=model/);
    assert.throws(() => parseArgs(['--model=claude= ']), /--model takes harness=model/);
    assert.throws(() => parseArgs(['--model=acp=x']), /Unknown harness: acp/);
    assert.throws(() => parseArgs(['--nope']), /Unknown option: --nope/);
    assert.throws(() => parseArgs(['--arms=x']), /Unknown arm: x/);
    assert.throws(() => parseArgs(['--harnesses=acp']), /Unknown harness: acp/);
    const homes = ['/Users/u/Library/Application Support/Google/Chrome'];
    const ok = { ...o, userDataDir: '/tmp/scratch' };
    assert.match(refusal(ok, { env: {}, homes, inVm: () => false }) as string, /release-only/);
    const env = { MOPILOT_RELEASE: '1' };
    assert.equal(refusal(ok, { env, homes }), null);
    assert.match(refusal({ ...ok, userDataDir: null }, { env, homes }) as string, /--user-data-dir is required/);
    assert.match(refusal({ ...ok, userDataDir: homes[0] }, { env, homes }) as string, /Chrome profile of yours/);
    assert.match(refusal({ ...ok, userDataDir: `${homes[0]}/Profile 1` }, { env, homes }) as string, /Chrome profile of yours/);
    assert.match(refusal({ ...ok, userDataDir: '/Users/u/Library' }, { env, homes }) as string, /Chrome profile of yours/);
    assert.match(refusal({ ...ok, app: null }, { env, homes }) as string, /--app is required/);
    assert.match(refusal(ok, { env: { ...env, MOPILOT_CHROME_RELAY_EXECUTABLE: '/x/brave' }, homes }) as string, /Google Chrome only/);
    assert.equal(refusal(ok, { env }) === null || typeof refusal(ok, { env }) === 'string', true);
    assert.match(chromeHomes('/h', 'darwin')[0], /^\/h\/Library\/Application Support\/Google\/Chrome$/);
    assert.equal(chromeHomes('C:\\Users\\u', 'win32', { LOCALAPPDATA: 'C:\\L' })[0], 'C:\\L\\Google\\Chrome\\User Data');
    assert.equal(
      chromeHomes('C:\\Users\\u', 'win32', {})[0],
      path.win32.join('C:\\Users\\u', 'AppData', 'Local', 'Google\\Chrome\\User Data'),
    );
    assert.equal(chromeHomes('/h', 'linux')[0], '/h/.config/google-chrome');
    assert.ok(chromeHomes().length > 0);
    assert.deepEqual(
      otherChromes(
        [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta --flag',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/scratch',
          '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer',
          '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/chrome_crashpad_handler --database=x',
          'node scripts/chrome-compare/run.mjs --user-data-dir /tmp/scratch',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/vim notes.txt',
        ].join('\n'),
        '/tmp/scratch',
      ),
      [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta --flag',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        '/usr/bin/google-chrome-stable',
      ],
    );
  });

  test('run: a scratch folder is compared as the disk sees it: links followed, and case where the disk ignores it', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-canon-')));
    try {
      const home = path.join(root, 'Google', 'Chrome');
      fs.mkdirSync(home, { recursive: true });
      fs.symlinkSync(home, path.join(root, 'link'));
      const env = { MOPILOT_RELEASE: '1' };
      const o = parseArgs(['--app=/a', `--user-data-dir=${path.join(root, 'link', 'Profile 1')}`]);
      assert.match(refusal(o, { env, homes: [home], platform: 'linux' }) as string, /Chrome profile of yours/);
      const upper = parseArgs(['--app=/a', `--user-data-dir=${path.join(root, 'GOOGLE', 'chrome')}`]);
      assert.match(refusal(upper, { env, homes: [home], platform: 'darwin' }) as string, /Chrome profile of yours/);
      assert.equal(canonical(path.join(root, 'link', 'a', 'b'), 'linux'), path.join(home, 'a', 'b'));
      assert.equal(canonical(path.join(root, 'link'), 'win32'), home.toLowerCase());
      assert.equal(typeof canonical('/'), 'string');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerProcessGuards() {
  test('run: what it reads of the machine: the process list, and its own modules', async () => {
    assert.match(psCommands(), /node/);
    assert.equal((await importModule('./tasks.mjs')).TASKS, TASKS);
  });

  test('run: the command line refuses without MOPILOT_RELEASE (outside a virtual machine; in one, it asks for its options)', () => {
    const env = { ...process.env };
    delete env.MOPILOT_RELEASE;
    const r = spawnSync(process.execPath, [new URL('../../../scripts/chrome-compare/run.mjs', import.meta.url).pathname], {
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, insideVirtualMachine() ? /--user-data-dir is required/ : /release-only/);
  });
}

export function registerExtensionGate() {
  test('run: the ext arm, the gate in an isolated virtual machine, the built extension it needs, and pairings in its runs', async () => {
    const o = parseArgs(['--arms=ext', '--app=/a', '--user-data-dir=/tmp/scratch']);
    assert.deepEqual(o.arms, ['ext']);
    const homes: string[] = [];
    // no MOPILOT_RELEASE: refused on a desktop, allowed in the virtual machine
    assert.match(refusal(o, { env: {}, homes, inVm: () => false, exists: () => true }) as string, /release-only/);
    assert.equal(refusal(o, { env: {}, homes, inVm: () => true, exists: () => true }), null);
    const looked: string[] = [];
    assert.match(
      refusal(o, { env: { MOPILOT_RELEASE: '1' }, homes, exists: (p: any) => (looked.push(p), false) }) as string,
      /npm run build:chrome-extension/,
    );
    assert.deepEqual(looked, [path.join('/a', 'dist', 'chrome-extension', 'manifest.json')]);
    // other arms need no built extension
    assert.equal(refusal({ ...o, arms: ['b2'] }, { env: { MOPILOT_RELEASE: '1' }, homes, exists: () => false }), null);
    const server = { base: 'http://b', records: {}, reset: () => undefined };
    const driver = fakeDriver(() => ({ answer: 'DE-4471', calls: 2, invalid: 0, cards: 0, pairings: 1, declined: 2 }));
    const { runs } = await runComparison(parseArgs(['--arms=ext', '--harnesses=claude', '--tasks=lookup']), {
      driver,
      server,
      tasks: selectTasks({ ids: ['lookup'] }),
      uploadFile: '/f',
    });
    assert.equal(runs[0].pairings, 1);
    assert.equal(runs[0].declined, 2);
    assert.equal(runs[0].ok, true);
  });
}
