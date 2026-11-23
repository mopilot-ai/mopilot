// orchestration Chrome comparison cases using shared fake drivers and page services.
import {
  test,
  assert,
  fs,
  os,
  path,
  UPLOAD_TEXT,
  selectTasks,
  ARMS,
  parseArgs,
  runComparison,
  main,
  insideVirtualMachine,
  fakeDriver,
  fakeChrome,
  ext,
} from './fixture.ts';

export function registerOrchestration() {
  test('run: every arm, harness, task and repeat, checked on the server; a driver failure fails that run only; native refuses beside another Chrome', async () => {
    const records: Record<string, any[]> = {};
    const server = { base: 'http://b', records, reset: () => Object.keys(records).forEach((k) => delete records[k]) };
    const tasks = selectTasks({ ids: ['lookup', 'spa'] });
    const driver = fakeDriver((prompt) => {
      if (prompt.includes('/spa')) {
        records['/spa/save'] = [{ theme: 'solarized' }];
        return { answer: 'done', calls: 3, invalid: 0, cards: 1 };
      }
      throw new Error('the app went away');
    });
    let t = 0;
    const lines: string[] = [];
    const o = parseArgs(['--arms=native,b2', '--harnesses=claude', '--repeat=2', '--user-data-dir=/tmp/s']);
    const { runs, summary } = await runComparison(o, {
      driver,
      server,
      tasks,
      uploadFile: '/tmp/f',
      now: () => (t += 1000),
      log: (s) => lines.push(s),
      ps: () => '',
    });
    assert.equal(runs.length, 8);
    assert.deepEqual(runs[0], {
      arm: 'native',
      harness: 'claude',
      task: 'lookup',
      ok: false,
      ms: 1000,
      calls: null,
      invalid: null,
      cards: 0,
      error: 'the app went away',
      posted: {},
    });
    assert.deepEqual(runs[2], {
      arm: 'native',
      harness: 'claude',
      task: 'spa',
      ok: true,
      ms: 1000,
      calls: 3,
      invalid: 0,
      cards: 1,
      answer: 'done',
    });
    assert.equal(summary.length, 2);
    assert.match(lines[0], /^native claude lookup: failed \(the app went away\)$/);
    assert.match(lines[2], /^native claude spa: ok$/);
    assert.deepEqual(
      driver.log.filter((l) => l[0] !== 'run'),
      [
        ['start', 'native', ARMS.native.flags],
        ['stop', 'native'],
        ['start', 'b2', ARMS.b2.flags],
        ['stop', 'b2'],
      ],
    );
    // a thrown non-Error is reported as written, and the default clock and log work
    const plain = fakeDriver(() => {
      throw 'plain';
    });
    const r2 = await runComparison(parseArgs(['--arms=b1', '--harnesses=codex', '--tasks=lookup']), {
      driver: plain,
      server,
      tasks: selectTasks({ ids: ['lookup'] }),
      uploadFile: '/tmp/f',
    });
    assert.equal(r2.runs[0].error, 'plain');
    await assert.rejects(
      runComparison(parseArgs(['--arms=native', '--user-data-dir=/tmp/s']), {
        driver,
        server,
        tasks,
        uploadFile: '/tmp/f',
        ps: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
      /Quit your own Chrome first/,
    );
    // the user opens their Chrome during the native arm: the next task is not run, and the instance is stopped
    let polls = 0;
    const opened = fakeDriver(() => ({ answer: 'DE-4471', calls: null, invalid: null, cards: 0 }));
    await assert.rejects(
      runComparison(parseArgs(['--arms=native', '--harnesses=claude', '--tasks=lookup', '--repeat=3', '--user-data-dir=/tmp/s']), {
        driver: opened,
        server,
        tasks: selectTasks({ ids: ['lookup'] }),
        uploadFile: '/tmp/f',
        ps: () => (++polls > 2 ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : ''),
      }),
      /Quit your own Chrome first/,
    );
    assert.equal(opened.log.filter((l) => l[0] === 'run').length, 1);
    assert.deepEqual(opened.log.at(-1), ['stop', 'native']);
    // the native arm with no ps reader: nothing else is taken to run
    const r3 = await runComparison(parseArgs(['--arms=native', '--harnesses=codex', '--tasks=lookup']), {
      driver: plain,
      server,
      tasks: selectTasks({ ids: ['lookup'] }),
      uploadFile: '/tmp/f',
    });
    assert.equal(r3.runs.length, 1);
    // a driver that timed the task's browser calls: they are kept on the run
    const acts = [{ tool: 't', action: 'click', ms: 5, error: false, chars: 40 }];
    const timed = await runComparison(parseArgs(['--arms=native', '--harnesses=codex', '--tasks=lookup']), {
      driver: fakeDriver(() => ({ answer: 'DE-4471', calls: null, invalid: null, cards: 0, actions: acts })),
      server,
      tasks: selectTasks({ ids: ['lookup'] }),
      uploadFile: '/tmp/f',
    });
    assert.deepEqual(timed.runs[0].actions, acts);
    assert.equal(timed.runs[0].resultChars, 40);
    assert.equal('resultChars' in r3.runs[0], false);
    assert.equal('actions' in r3.runs[0], false);
  });

  test('run main: bad options and the guards exit 2; a run writes its runs and summary, with the real page server', async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const out = { error: (s: string) => errors.push(s), log: (s: string) => logs.push(s) };
    assert.equal(await main(['--nope'], { env: {}, out }), 2);
    assert.equal(await main([], { env: {}, out }), 2);
    assert.match(errors.at(-1) as string, insideVirtualMachine() ? /--user-data-dir is required/ : /release-only/);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-compare-test-'));
    try {
      const launched: any[] = [];
      // Chrome is opened on the scratch profile to sign in; a fake here, as a unit test never starts a browser
      const opened: string[][] = [];
      const spawn: any = (_cmd: string, args: string[]) => (opened.push(args), { unref() {} });
      const load = async (p: string) => {
        if (p === '@playwright/test') return { _electron: { launch: async (o: any) => (launched.push(o), null) } };
        return import(new URL(`../../../scripts/chrome-compare/${p.replace('./', '')}`, import.meta.url).href);
      };
      // the driver's start needs a window: the launch above has none, so the arm fails before any task, and main says so
      await assert.rejects(
        main(
          [
            '--arms=b2',
            '--harnesses=claude',
            '--tasks=signed-in',
            '--user-data-dir',
            path.join(work, 'scratch'),
            '--app',
            work,
            '--out',
            path.join(work, 'out'),
            '--effort=low',
          ],
          {
            env: { MOPILOT_RELEASE: '1' },
            homes: [],
            load,
            out,
            spawn,
          },
        ),
      );
      assert.equal(launched.length, 1);
      // the sign-in opened the scratch profile at the page server's /login, through the injected spawn only
      assert.equal(opened.length, 1);
      assert.equal(opened[0][0], `--user-data-dir=${path.join(work, 'scratch')}`);
      assert.match(opened[0][1], /^http:\/\/127\.0\.0\.1:\d+\/login$/);
      assert.equal(launched[0].env.MOPILOT_CHROME_RELAY_USER_DATA_DIR, path.join(work, 'scratch'));
      assert.equal(fs.readFileSync(path.join(work, 'out', 'receipt-7731.txt'), 'utf8'), UPLOAD_TEXT);
      // --effort is the instance's default reasoning effort for a Codex chat
      assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'out', 'mopilot-b2', 'ui-state.json'), 'utf8')).prefs.effort, 'low');
      // the ext arm: the built extension is loaded into the arm's own Chrome (a fake), and what it does is logged
      fs.mkdirSync(path.join(work, 'dist', 'chrome-extension'), { recursive: true });
      fs.writeFileSync(path.join(work, 'dist', 'chrome-extension', 'manifest.json'), '{}');
      const fc = fakeChrome({
        'Extensions.loadUnpacked': { id: 'extid' },
        'Target.getTargets': ext('extid'),
        'Target.setDiscoverTargets': {},
      });
      await assert.rejects(
        main(['--arms=ext', '--harnesses=claude', '--tasks=lookup', '--user-data-dir', path.join(work, 'scratch'), '--app', work], {
          env: { MOPILOT_RELEASE: '1' },
          homes: [],
          load,
          out,
          spawn: fc.spawn,
        }),
      );
      assert.ok(logs.some((l) => /loaded MoPilot's extension extid/.test(l)));
      // a driver that runs: runs.json and summary.md are written (no --out: a temporary folder)
      const fakeLoad = async (p: string) => {
        if (p === './driver.mjs')
          return { electronDriver: () => fakeDriver(() => ({ answer: 'DE-4471', calls: 1, invalid: 0, cards: 0 })) };
        return load(p);
      };
      assert.equal(
        await main(['--arms=b2', '--harnesses=codex', '--tasks=lookup', '--user-data-dir', path.join(work, 'scratch'), '--app', work], {
          env: { MOPILOT_RELEASE: '1' },
          homes: [],
          load: fakeLoad,
          out,
          spawn,
        }),
        0,
      );
      // --probe: a module's default export reaches the driver
      const probeFile = path.join(work, 'probe.mjs');
      fs.writeFileSync(probeFile, 'export default async () => undefined;');
      assert.equal(parseArgs(['--probe', probeFile]).probe, probeFile);
      assert.equal(parseArgs(['--flags', ' shared.browser.chromePageTree=1 ']).flags, 'shared.browser.chromePageTree=1');
      let given: any = null;
      const probeLoad = async (p: string) => {
        if (p === './driver.mjs')
          return {
            electronDriver: (o: any) => ((given = o.probe), fakeDriver(() => ({ answer: 'DE-4471', calls: 1, invalid: 0, cards: 0 }))),
          };
        return p.startsWith('file:') ? import(p) : load(p);
      };
      assert.equal(
        await main(
          [
            '--arms=b2',
            '--harnesses=codex',
            '--tasks=lookup',
            '--probe',
            probeFile,
            '--user-data-dir',
            path.join(work, 'scratch'),
            '--app',
            work,
          ],
          {
            env: { MOPILOT_RELEASE: '1' },
            homes: [],
            load: probeLoad,
            out,
            spawn,
          },
        ),
        0,
      );
      assert.equal(typeof given, 'function');
      const where = (logs.at(-1) as string).replace(/^Written to /, '');
      assert.equal(JSON.parse(fs.readFileSync(path.join(where, 'runs.json'), 'utf8'))[0].ok, true);
      assert.match(fs.readFileSync(path.join(where, 'summary.md'), 'utf8'), /\| b2 \| codex \| 1 \| 100% \|/);
      fs.rmSync(where, { recursive: true, force: true });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}
