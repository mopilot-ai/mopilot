// scripts/check-fuses.mjs, scripts/dev.mjs and scripts/make-ico.mjs with their tools replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FuseState, FuseV1Options } from '@electron/fuses';
import { recorder, runScript, tempDir } from './support/scripts-shared-cli.ts';

const fuses = await import('../scripts/check-fuses.mjs');
const dev = await import('../scripts/dev.mjs');
const icons = await import('../scripts/make-ico.mjs');

const goodWire = () => {
  const wire: Record<string, number> = {};
  for (const [k, want] of Object.entries(fuses.FUSES)) if (k !== 'version') wire[k] = want ? FuseState.ENABLE : FuseState.DISABLE;
  return wire;
};

test('fuses: a wire matching FUSES passes; each wrong fuse is named with what it is', async () => {
  const log = recorder();
  await fuses.checkFuses('/A.app', { readWire: async () => goodWire() as any, log });
  assert.deepEqual(log.calls, [['Fuses OK:', '/A.app']]);
  const wire = goodWire();
  wire[FuseV1Options.RunAsNode] = FuseState.ENABLE;
  wire[FuseV1Options.OnlyLoadAppFromAsar] = FuseState.DISABLE;
  delete wire[FuseV1Options.EnableCookieEncryption];
  await assert.rejects(fuses.checkFuses('/B.app', { readWire: async () => wire as any, log }), (e: Error) => {
    assert.equal(
      e.message,
      'Electron fuses are wrong in /B.app:\n  RunAsNode: want off, got on\n  EnableCookieEncryption: want on, got missing\n  OnlyLoadAppFromAsar: want on, got off',
    );
    return true;
  });
});

test("fuses command line: the default app is this arch's package; a failure exits 1 with the reason", async () => {
  const check = recorder(async () => {});
  assert.equal(await fuses.main([], { check, arch: 'arm64' }), 0);
  assert.deepEqual(check.calls[0], ['out/MoPilot-darwin-arm64/MoPilot.app']);
  const error = recorder();
  assert.equal(
    await fuses.main(['/x.app'], {
      check: async (a: string) => {
        throw new Error(`bad ${a}`);
      },
      error,
    }),
    1,
  );
  assert.deepEqual(error.calls, [['bad /x.app']]);
  const r = runScript('scripts/check-fuses.mjs', [path.join(tempDir(), 'missing.app')]);
  assert.equal(r.status, 1);
  assert.notEqual(r.stderr, '');
});

function fakeServer() {
  return { listen: recorder(async () => {}), close: recorder(), resolvedUrls: { local: ['http://localhost:5199/'] } };
}

/** The core's build, which no test here runs. */
const noCore = () => null;

test('dev: Electron starts against the server on the chosen ports, and its exit stops everything', async () => {
  const server = fakeServer();
  const create = recorder(async () => server);
  const child = new EventEmitter();
  const run = recorder(() => child);
  const exit = recorder();
  const env = { SAGE_DEV_PORT: '5199', SAGE_DEBUG_PORT: '9400', HOME: '/h' };
  const ensure = recorder(() => '/built/sage-mcp');
  const log = recorder();
  assert.equal(
    await dev.startDev({
      buildCore: noCore,
      env,
      create: create as any,
      run: run as any,
      electronPath: '/electron',
      exit: exit as any,
      ensure,
      platform: 'darwin',
      log,
    }),
    child,
  );
  // the tool bridge is current before Electron starts, quietly when it is
  assert.deepEqual(ensure.calls, [[{ log }]]);
  assert.deepEqual(log.calls, []);
  assert.deepEqual(create.calls[0], [{ configFile: 'vite.config.mts', server: { port: 5199, strictPort: true } }]);
  assert.equal(server.listen.calls.length, 1);
  assert.deepEqual(run.calls[0], [
    '/electron',
    ['.', '--remote-debugging-port=9400'],
    { stdio: 'inherit', env: { ...env, VITE_DEV_SERVER_URL: 'http://localhost:5199/' } },
  ]);
  child.emit('exit');
  assert.equal(server.close.calls.length, 1);
  assert.deepEqual(exit.calls, [[0]]);
});

test('dev: the Rust core is current before Electron starts, on every platform', async () => {
  const buildCore = recorder(() => '/built/core');
  const log = recorder();
  await dev.startDev({
    buildCore,
    env: {},
    create: recorder(async () => fakeServer()) as any,
    run: recorder(() => new EventEmitter()) as any,
    platform: 'linux',
    log,
  });
  assert.deepEqual(buildCore.calls, [[{ log }]]);
});

test('dev: without a swift toolchain, or when the build fails, the run still starts and says its chats get no MoPilot tools (#1362)', async () => {
  const run = recorder(() => new EventEmitter());
  const log = recorder();
  const ensure = recorder(() => null);
  const create = recorder(async () => fakeServer());
  await dev.startDev({
    buildCore: noCore,
    env: {},
    create: create as any,
    run: run as any,
    electronPath: '/electron',
    exit: (() => {}) as any,
    ensure,
    platform: 'darwin',
    log,
  });
  assert.deepEqual(log.calls, [['sage-mcp is not built: chats in this run get no MoPilot tools.']]);
  assert.equal(run.calls.length, 1);
  // a build that fails (or a lock wait that gives up) starts the app all the same, with the reason
  const failed = recorder();
  const run2 = recorder(() => new EventEmitter());
  const boom = () => {
    throw new Error('swift build failed');
  };
  await dev.startDev({
    buildCore: noCore,
    env: {},
    create: create as any,
    run: run2 as any,
    electronPath: '/electron',
    exit: (() => {}) as any,
    ensure: boom,
    platform: 'darwin',
    log: failed,
  });
  assert.deepEqual(failed.calls, [
    ['sage-mcp could not be built: swift build failed'],
    ['sage-mcp is not built: chats in this run get no MoPilot tools.'],
  ]);
  assert.equal(run2.calls.length, 1);
  const odd = recorder();
  const rejects = () => {
    throw 'no lock';
  };
  await dev.startDev({
    buildCore: noCore,
    env: {},
    create: create as any,
    run: run2 as any,
    electronPath: '/electron',
    exit: (() => {}) as any,
    ensure: rejects,
    platform: 'darwin',
    log: odd,
  });
  assert.equal(odd.calls[0][0], 'sage-mcp could not be built: no lock');
});

test('dev: a test instance starts only where a release-only suite may, before anything is built or served', async () => {
  for (const env of [{ SAGE_E2E_BACKGROUND: '1' }, { MOPILOT_TEST_RUN: 'r1' }]) {
    const create = recorder(async () => fakeServer());
    const ensure = recorder(() => '/built/sage-mcp');
    const gate = recorder(() => {
      throw new Error('release-only');
    });
    await assert.rejects(
      dev.startDev({
        buildCore: noCore,
        env,
        create: create as any,
        run: recorder() as any,
        exit: (() => {}) as any,
        ensure,
        platform: 'darwin',
        gate,
      }),
      /release-only/,
    );
    assert.deepEqual(gate.calls, [
      ['A test instance of MoPilot', 'opens MoPilot windows on this computer and its chats use the logins here', env],
    ]);
    assert.deepEqual([create.calls.length, ensure.calls.length], [0, 0]);
  }
  // in a release, a virtual machine or on CI the gate lets it through; the user's own run (neither switch) never asks
  const run = recorder(() => new EventEmitter());
  const env = { SAGE_E2E_BACKGROUND: '1', MOPILOT_RELEASE: '1' };
  await dev.startDev({
    buildCore: noCore,
    env,
    create: async () => fakeServer() as any,
    run: run as any,
    exit: (() => {}) as any,
    platform: 'linux',
  });
  assert.equal(run.calls.length, 1);
  const unused = recorder();
  await dev.startDev({
    buildCore: noCore,
    env: { SAGE_E2E_BACKGROUND: '0' },
    create: async () => fakeServer() as any,
    run: recorder(() => new EventEmitter()) as any,
    exit: (() => {}) as any,
    platform: 'linux',
    gate: unused,
  });
  assert.equal(unused.calls.length, 0);
});

test('dev: without overrides Vite picks the port and the debugger listens on 9339', async () => {
  const create = recorder(async () => fakeServer());
  const run = recorder(() => new EventEmitter());
  const ensure = recorder(() => '/built/sage-mcp');
  await dev.startDev({
    buildCore: noCore,
    env: {},
    create: create as any,
    run: run as any,
    electronPath: '/electron',
    exit: (() => {}) as any,
    ensure,
    platform: 'linux',
  });
  assert.deepEqual(ensure.calls, [], 'sage-mcp builds on macOS only');
  assert.deepEqual(create.calls[0], [{ configFile: 'vite.config.mts' }]);
  assert.deepEqual(run.calls[0][1], ['.', '--remote-debugging-port=9339']);
  const start = recorder(async () => {});
  await dev.cli([], { start: start as any });
  assert.equal(start.calls.length, 1);
  const r = runScript('scripts/dev.mjs', ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: npm run dev/);
});

// ---------- PNG fixtures for make-ico ----------
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

/** Pseudo-random pixels, so every Paeth predictor branch is taken. */
function pixels(w: number, h: number, bpp: number, seed = 7) {
  let x = seed;
  return Array.from({ length: h }, () =>
    Buffer.from(Array.from({ length: w * bpp }, () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff)),
  );
}

function filterRow(f: number, line: Buffer, prev: Buffer, bpp: number) {
  const out = Buffer.alloc(line.length);
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    const p = a + b - c;
    const pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
    out[i] = (line[i] - pred) & 0xff;
  }
  return out;
}

function png(
  w: number,
  h: number,
  { colorType = 6, depth = 8, interlace = 0, rows = pixels(w, h, colorType === 6 ? 4 : 3), filters = [0, 1, 2, 3, 4, 9] } = {},
) {
  const bpp = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  let prev = Buffer.alloc(w * bpp);
  const raw = rows.map((line, y) => {
    const f = filters[y % filters.length];
    const row = Buffer.concat([Buffer.from([f]), filterRow(f, line, prev, bpp)]);
    prev = line;
    return row;
  });
  const z = zlib.deflateSync(Buffer.concat(raw));
  const half = z.length >> 1;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return {
    buf: Buffer.concat([
      sig,
      chunk('IHDR', ihdr),
      chunk('tEXt', Buffer.from('x')),
      chunk('IDAT', z.subarray(0, half)),
      chunk('IDAT', z.subarray(half)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
    rows,
  };
}

test('icons: RGBA and RGB PNGs decode through every row filter', () => {
  const rgba = png(9, 12);
  const out = icons.decodePng(rgba.buf);
  assert.deepEqual([out.w, out.h], [9, 12]);
  assert.deepEqual(out.px, Buffer.concat(rgba.rows));
  const rgb = png(5, 6, { colorType: 2 });
  const px = icons.decodePng(rgb.buf).px;
  for (let i = 0; i < 30; i++) {
    const row = rgb.rows[Math.floor(i / 5)];
    assert.deepEqual([...px.subarray(i * 4, i * 4 + 4)], [...row.subarray((i % 5) * 3, (i % 5) * 3 + 3), 255]);
  }
});

test('icons: 16-bit, interlaced and palette PNGs are refused', () => {
  assert.throws(() => icons.decodePng(png(2, 2, { depth: 16 }).buf), /unsupported PNG \(depth 16, type 6, interlace 0\)/);
  assert.throws(() => icons.decodePng(png(2, 2, { interlace: 1 }).buf), /interlace 1/);
  assert.throws(() => icons.decodePng(png(2, 2, { colorType: 3 }).buf), /type 3/);
});

test('icons: a DIB entry is BGRA bottom-up with transparent pixels in its AND mask', () => {
  const rows = [Buffer.from([1, 2, 3, 0, 4, 5, 6, 255]), Buffer.from([7, 8, 9, 255, 10, 11, 12, 0])];
  const d = icons.dib(png(2, 2, { rows, filters: [0] }).buf);
  assert.equal(d.readUInt32LE(0), 40);
  assert.deepEqual([d.readInt32LE(4), d.readInt32LE(8), d.readUInt16LE(12), d.readUInt16LE(14), d.readUInt32LE(20)], [2, 4, 1, 32, 16]);
  assert.deepEqual([...d.subarray(40, 56)], [9, 8, 7, 255, 12, 11, 10, 0, 3, 2, 1, 0, 6, 5, 4, 255]);
  // mask rows are 4 bytes, bottom-up: the bottom row's second pixel, then the top row's first
  assert.deepEqual([...d.subarray(56)], [0x40, 0, 0, 0, 0x80, 0, 0, 0]);
});

test('icons: small sizes are DIBs, large ones PNGs, and 256 is written as 0 in the directory', () => {
  const pngs = new Map([16, 64, 256].map((s) => [s, png(s, s, { filters: [1] }).buf]));
  const out = icons.ico([16, 64, 256], (s: number) => pngs.get(s));
  assert.deepEqual([out.readUInt16LE(0), out.readUInt16LE(2), out.readUInt16LE(4)], [0, 1, 3]);
  const entry = (i: number) => {
    const e = 6 + i * 16;
    return {
      w: out[e],
      h: out[e + 1],
      planes: out.readUInt16LE(e + 4),
      bits: out.readUInt16LE(e + 6),
      size: out.readUInt32LE(e + 8),
      offset: out.readUInt32LE(e + 12),
    };
  };
  const dibSize = 40 + 16 * 16 * 4 + 4 * 16;
  assert.deepEqual(entry(0), { w: 16, h: 16, planes: 1, bits: 32, size: dibSize, offset: 54 });
  assert.deepEqual(entry(1), { w: 64, h: 64, planes: 1, bits: 32, size: pngs.get(64)!.length, offset: 54 + dibSize });
  assert.deepEqual([entry(2).w, entry(2).h], [0, 0]);
  assert.deepEqual(out.subarray(entry(1).offset, entry(1).offset + entry(1).size), pngs.get(64));
});

test('icons: the command writes both icons from sips output and removes its scratch folder', () => {
  let scratch = '';
  const exec = recorder((_cmd: string, args: string[]) => {
    const out = args.at(-1)!;
    scratch = path.dirname(out);
    const s = Number(args[4]);
    fs.writeFileSync(out, png(s, s, { filters: [2] }).buf);
  });
  const write = recorder();
  const log = recorder();
  icons.main({ exec: exec as any, write, log });
  assert.deepEqual(exec.calls[0].slice(0, 2), [
    'sips',
    ['-s', 'format', 'png', '-z', '16', '16', 'build/icon.png', '--out', path.join(scratch, '16.png')],
  ]);
  assert.equal(exec.calls.length, 13);
  assert.deepEqual(
    write.calls.map((c) => [c[0], c[1].readUInt16LE(4)]),
    [
      ['build/icon.ico', 7],
      ['electron/tray.ico', 6],
    ],
  );
  assert.deepEqual(log.calls, [['Wrote build/icon.ico and electron/tray.ico']]);
  assert.equal(fs.existsSync(scratch), false);
  const run = recorder();
  icons.cli([], { run });
  assert.equal(run.calls.length, 1);
  const r = runScript('scripts/make-ico.mjs', ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: node scripts\/make-ico\.mjs/);
});
