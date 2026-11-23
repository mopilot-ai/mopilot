// Spawn/result contracts, pinned CLI schemas and process protocol cases.
import { test, assert, fs, os, path, spawn, require, spawnSpec, pageUrl, sageName, NEEDS, HOST, fakeFork } from './fixture.ts';

export function registerEntryContracts() {
  test('extension entrypoint retains transport, result contract and tool handler identities', () => {
    const entry = require('../../../electron/capabilities/browser/extension.cjs');
    for (const [file, names] of [
      ['extensionProcess', ['PlaywrightInstance', 'spawnSpec', 'HOST']],
      ['extensionResults', ['pageUrl', 'modalStates', 'sageName', 'NEEDS']],
      ['extensionTools', ['chromeTools']],
    ] as const) {
      const implementation = require(`../../../electron/capabilities/browser/${file}.cjs`);
      for (const name of names) assert.equal(entry[name], implementation[name], name);
    }
  });

  test('spawnSpec preserves the explicitly configured scratch Chrome profile', () => {
    const spec = spawnSpec({ outputDir: '/out', env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/scratch/chrome' } });
    assert.equal(spec.options.env.PWTEST_EXTENSION_USER_DATA_DIR, '/scratch/chrome');
  });
}

export function registerSpawnAndResults() {
  test('spawnSpec: --extension in a utility process, with only the env the CLI needs', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/Users/me',
      TMPDIR: '/tmp/x',
      ANTHROPIC_API_KEY: 'sk-secret',
      ELECTRON_RUN_AS_NODE: '1',
      OPENAI_API_KEY: 'k',
    };
    const s = spawnSpec({ outputDir: '/data/out', profileDir: 'Profile 2', token: 'tok', env });
    assert.equal(s.modulePath, HOST);
    assert.ok(fs.existsSync(HOST));
    assert.deepEqual(s.args, [
      '--extension',
      '--output-dir',
      '/data/out',
      '--image-responses',
      'allow',
      '--codegen',
      'none',
      '--no-webmcp',
      '--profile-dir-name',
      'Profile 2',
    ]);
    assert.equal(s.options.stdio, 'pipe');
    assert.equal(s.options.cwd, '/data/out');
    assert.deepEqual(s.options.env, {
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      PATH: '/usr/bin',
      HOME: '/Users/me',
      TMPDIR: '/tmp/x',
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'tok',
    });
    const bare = spawnSpec({ outputDir: '/o', env: { HOME: '/h' } });
    assert.ok(!bare.args.includes('--profile-dir-name'));
    assert.equal(bare.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined);
  });

  test('pinned: @playwright/mcp is an exact version', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.dependencies['@playwright/mcp'], '0.0.83');
    assert.equal(require('@playwright/mcp/package.json').version, '0.0.83');
  });

  test('pageUrl and sageName', () => {
    assert.equal(pageUrl([{ type: 'text', text: '### Page\n- Page URL: https://a.test/x\n- Page Title: A' }]), 'https://a.test/x');
    assert.equal(pageUrl([{ type: 'image', data: '' }]), null);
    assert.equal(pageUrl([{ type: 'text' }, { type: 'text', text: 42 }]), null);
    assert.equal(pageUrl({ type: 'text', text: 'Page URL: https://a.test' }), null);
    assert.equal(sageName('browser_take_screenshot'), 'sage_browser_take_screenshot');
    assert.equal(sageName('browser_evaluate'), null);
    assert.equal(sageName('browser_file_upload'), null);
    assert.equal(sageName('browser_run_code_unsafe'), null);
  });
}

export function registerPinnedCliSchemas() {
  test('the pinned CLI in --extension mode lists every tool MoPilot proxies, with schemas zod accepts', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-'));
    const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
    const spec = spawnSpec({ outputDir: home, env: { PATH: process.env.PATH, HOME: home } });
    const child = spawn(process.execPath, [cli, ...spec.args], { cwd: home, env: spec.options.env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const waiting = new Map<number, (v: any) => void>();
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        waiting.get(msg.id)?.(msg.result);
      }
    });
    let id = 0;
    const req = (method: string, params: any) =>
      new Promise<any>((resolve) => {
        waiting.set(++id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    try {
      await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      const { tools } = await req('tools/list', {});
      const listed = new Set(tools.map((t: any) => t.name));
      for (const name of Object.keys(NEEDS)) assert.ok(listed.has(name), `${name} is in @playwright/mcp's list`);
      const { z } = require('zod');
      for (const t of tools.filter((x: any) => NEEDS[x.name])) assert.doesNotThrow(() => z.fromJSONSchema(t.inputSchema), t.name);
    } finally {
      child.stdin.end();
      child.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

export function registerProcessFailures() {
  test('Chrome process protocol ignores malformed output, reports RPC errors, timeouts, and exits', async (t) => {
    const { PlaywrightInstance } = require('../../../electron/capabilities/browser/extension.cjs');
    const { fork, children } = fakeFork();
    // the default call timeout while it starts: a real 20 ms one could pass before the fake answers on a busy machine
    const inst = new PlaywrightInstance({ fork, spec: spawnSpec({ outputDir: '/o', env: {} }), clientName: 'Test' });
    inst.stop();
    await inst.start();
    inst.callMs = 20;
    const child = children[0];
    child.emit('message', null);
    child.emit('message', { type: 'wrong' });
    child.emit('message', { type: 'out', data: 3 });
    child.emit('message', {
      type: 'out',
      data: '\ninvalid json\n{"method":"notification"}\n{"id":123,"method":"notification"}\n{"id":999,"result":{}}\n',
    });
    child.emit('message', { type: 'out', data: '{"id":' });
    child.emit('message', { type: 'out', data: '999,"result":{}}\n' });
    const reply = (result: any) => {
      const [id] = [...inst.pending.keys()];
      child.emit('message', { type: 'out', data: JSON.stringify({ id, ...result }) + '\n' });
    };
    const namedError = inst.request('error', {});
    reply({ error: { message: 'RPC failed' } });
    await assert.rejects(namedError, /RPC failed/);
    const genericError = inst.request('error', {});
    reply({ error: {} });
    await assert.rejects(genericError, /Playwright MCP error/);
    const emptyTools = inst.listTools();
    reply({ result: null });
    assert.deepEqual(await emptyTools, []);
    const missingTools = inst.listTools();
    reply({ result: {} });
    assert.deepEqual(await missingTools, []);
    const emptyCall = inst.call('empty');
    reply({ result: null });
    assert.deepEqual(await emptyCall, {});
    const knownCall = inst.call('known', {});
    reply({ result: { content: [{ type: 'text', text: 'Page URL: https://task.test/' }] } });
    await knownCall;
    assert.equal(inst.url, 'https://task.test/');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timeout = inst.request('never-answers', {});
    const timeoutCheck = assert.rejects(timeout, /in time/);
    t.mock.timers.tick(20);
    await timeoutCheck;
    const exited = inst.request('exit-during-request', {});
    const exitCheck = assert.rejects(exited, /stopped/);
    child.emit('exit', 1);
    await exitCheck;
    await assert.rejects(inst.request('after-exit', {}), /stopped/);
    inst.stop();
  });

  test('Chrome stop kills an unresponsive process and tolerates a disconnected parent port', async (t) => {
    const { PlaywrightInstance } = require('../../../electron/capabilities/browser/extension.cjs');
    const { fork, children } = fakeFork();
    const inst = new PlaywrightInstance({ fork, spec: spawnSpec({ outputDir: '/o', env: {} }), clientName: 'Test' });
    await inst.start();
    children[0].postMessage = () => {
      throw new Error('disconnected');
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    inst.stop();
    t.mock.timers.tick(5000);
    assert.equal(children[0].killed, true);
  });

  test('Windows Chrome spawn copies system environment case-insensitively and omits absent values', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const spec = spawnSpec({
        outputDir: 'C:/out',
        env: {
          systemroot: 'C:/Windows',
          userprofile: 'C:/Users/me',
          LOCALAPPDATA: 'C:/local',
          APPDATA: 'C:/roaming',
          ProgramFiles: 'C:/Program Files',
          'ProgramFiles(x86)': 'C:/Program Files x86',
          TEMP: 'C:/temp',
          TMP: 'C:/tmp',
          ComSpec: 'C:/Windows/cmd.exe',
        },
      });
      assert.equal(spec.options.env.SystemRoot, 'C:/Windows');
      assert.equal(spec.options.env.USERPROFILE, 'C:/Users/me');
      assert.equal(spawnSpec({ outputDir: 'C:/out', env: {} }).options.env.TEMP, undefined);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
}
