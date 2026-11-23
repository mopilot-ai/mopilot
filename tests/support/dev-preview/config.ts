// Launch configuration, local URL parsing and port-probe cases.
import {
  test,
  assert,
  EventEmitter,
  net,
  path,
  readLaunchConfigs,
  findLocalUrl,
  portOf,
  probePort,
  stripAnsi,
  LAUNCH_FILES,
  project,
  freePort,
} from './fixture.ts';

export function registerConfig() {
  test('findLocalUrl: the first local URL a server prints, 0.0.0.0 and [::] read as localhost; portOf and stripAnsi', () => {
    assert.equal(
      findLocalUrl('  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m'),
      'http://localhost:5173/',
    );
    assert.equal(findLocalUrl('ready on http://0.0.0.0:3000'), 'http://localhost:3000/');
    assert.equal(findLocalUrl('listening https://[::]:8443/app?x=1 now'), 'https://localhost:8443/app?x=1');
    assert.equal(findLocalUrl('at http://[::1]:9000/'), 'http://[::1]:9000/');
    assert.equal(findLocalUrl('see http://127.0.0.1/'), 'http://127.0.0.1/');
    assert.equal(findLocalUrl('Local: HTTPS://localhost:5173'), 'https://localhost:5173/');
    assert.equal(findLocalUrl('docs at https://example.com:443/'), null);
    assert.equal(findLocalUrl('nothing'), null);
    assert.equal(portOf('http://localhost:5173/'), 5173);
    assert.equal(portOf('http://localhost/'), 80);
    assert.equal(portOf('https://localhost/'), 443);
    assert.equal(portOf('nope'), null);
    assert.equal(stripAnsi('\u001b[1mbold\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007'), 'bold link');
    assert.deepEqual(LAUNCH_FILES, ['.mopilot/launch.json', '.claude/launch.json']);
  });

  test('readLaunchConfigs: .mopilot first, then .claude; validated, with ${workspaceFolder} and folders resolved', () => {
    const dir = project({
      '.mopilot/launch.json': {
        configurations: [
          {
            name: 'web',
            runtimeExecutable: 'npm',
            runtimeArgs: ['run', 'dev'],
            port: 5173,
            cwd: 'app',
            env: { A: '${workspaceFolder}/x', B: null, C: 1 },
          },
          { name: 'bad' },
          null,
        ],
      },
      '.claude/launch.json': {
        version: '0.0.1',
        configurations: [
          { name: 'web', runtimeExecutable: 'other' },
          {
            name: 'api',
            runtimeExecutable: '${workspaceFolder}/bin/api',
            runtimeArgs: 'x',
            port: 70000,
            url: 'http://localhost:8080/health',
            cwd: '${workspaceFolder}/srv',
          },
          { name: 'u', runtimeExecutable: 'u', url: 'ftp://x', port: 3.5 },
        ],
      },
    });
    const { configs, errors } = readLaunchConfigs(dir);
    assert.deepEqual(configs, [
      {
        name: 'web',
        runtimeExecutable: 'npm',
        runtimeArgs: ['run', 'dev'],
        port: 5173,
        url: null,
        cwd: path.join(dir, 'app'),
        env: { A: `${dir}/x`, C: '1' },
        source: '.mopilot/launch.json',
      },
      {
        name: 'api',
        runtimeExecutable: `${dir}/bin/api`,
        runtimeArgs: [],
        port: null,
        url: 'http://localhost:8080/health',
        cwd: path.join(dir, 'srv'),
        env: {},
        source: '.claude/launch.json',
      },
      { name: 'u', runtimeExecutable: 'u', runtimeArgs: [], port: null, url: null, cwd: dir, env: {}, source: '.claude/launch.json' },
    ]);
    assert.deepEqual(errors, [
      '.mopilot/launch.json: a configuration needs a name and a runtimeExecutable',
      '.mopilot/launch.json: a configuration needs a name and a runtimeExecutable',
    ]);
    // a broken file is reported; a missing one is not; no folder reads nothing
    const broken = project({ '.claude/launch.json': '{ nope' });
    assert.match(readLaunchConfigs(broken).errors[0], /^\.claude\/launch\.json: /);
    assert.deepEqual(readLaunchConfigs(project({ '.claude/launch.json': { configurations: 'x' } })), { configs: [], errors: [] });
    assert.deepEqual(readLaunchConfigs(null), { configs: [], errors: [] });
    assert.deepEqual(
      readLaunchConfigs('/x', {
        readFile: () => {
          throw 'odd';
        },
      }).errors,
      ['.mopilot/launch.json: odd', '.claude/launch.json: odd'],
    );
  });

  test('probePort: an open port answers; a closed one, a connect that throws or hangs does not', async () => {
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as any;
    assert.equal(await probePort(port, { host: '127.0.0.1' }), true);
    server.close();
    assert.equal(await probePort(await freePort(), { host: '127.0.0.1' }), false);
    assert.equal(
      await probePort(1, {
        connect: () => {
          throw new Error('bad');
        },
      }),
      false,
    );
    const hang = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      setTimeout(ms: number, cb: any) {
        setTimeout(cb, ms);
      },
    });
    assert.equal(await probePort(1, { connect: () => hang as any, timeoutMs: 5 }), false);
    assert.equal(hang.destroyed, true);
  });
}
