// The phone app is named MoPilot and its icons, splash and notification images are the desktop icon's: names, files, sizes, colors and the generator.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync, crc32 } from 'node:zlib';

const scripts = '../mobile/scripts/';
const { decodePng, encodePng, pngInfo } = await import(`${scripts}png.mjs`);
const { ICONS, readBrand, renderIcon, writeIcons } = await import(`${scripts}icons.mjs`);

const root = new URL('../', import.meta.url).pathname;
const desktopIcon = `${root}build/icon.png`;
const app = JSON.parse(readFileSync(`${root}mobile/app.json`, 'utf8')).expo;
const assetPath = (ref: string) => `${root}mobile/${ref.replace(/^\.\//, '')}`;

/** Builds a PNG chunk by hand so a test can craft files the encoder never writes. */
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function craft({
  colorType = 6,
  depth = 8,
  interlace = 0,
  rows,
}: {
  colorType?: number;
  depth?: number;
  interlace?: number;
  rows: Buffer;
}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('the app is named MoPilot on the home screen while its slug and bundle ids stay as paired and signed', () => {
  assert.equal(app.name, 'MoPilot');
  assert.equal(app.slug, 'mopilot-remote');
  assert.equal(app.ios.bundleIdentifier, 'ai.mopilot.phone');
  assert.equal(app.android.package, 'ai.mopilot.remote');
  const camera = app.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-camera');
  assert.match(camera[1].cameraPermission, /pairing code/);
});

test('each permission prompt names what the app does with it: the camera scans a code and takes photos, the microphone records voice notes, the library attaches photos', () => {
  const options = (name: string) => (app.plugins.find((p: unknown) => Array.isArray(p) && p[0] === name) ?? [])[1] ?? {};
  assert.match(options('expo-camera').cameraPermission, /pairing code/);
  assert.match(options('expo-camera').cameraPermission, /photo/i, 'the same camera key is shown when a photo is taken for a chat');
  assert.match(options('expo-image-picker').cameraPermission, /photo/i);
  assert.match(options('expo-image-picker').photosPermission, /attach/i);
  assert.match(options('expo-audio').microphonePermission, /voice note/i);
  for (const key of ['cameraPermission', 'photosPermission', 'microphonePermission']) {
    for (const name of ['expo-camera', 'expo-image-picker', 'expo-audio']) {
      const text = options(name)[key];
      if (text !== undefined) {
        assert.match(text, /^Allow MoPilot to /, `${name} ${key}`);
        assert.equal(text.includes('PRODUCT_NAME'), false);
        assert.ok(text.length <= 120, `${name} ${key} stays short`);
      }
    }
  }
});

test('no user-visible text still says MoPilot Remote', () => {
  for (const file of [
    'mobile/app.json',
    'mobile/README.md',
    'mobile/src/MobileApp.tsx',
    'mobile/src/screens/HomeStatus.tsx',
    'mobile/src/push/NotificationsCard.tsx',
  ]) {
    assert.equal(readFileSync(root + file, 'utf8').includes('MoPilot Remote'), false, file);
  }
  assert.match(readFileSync(`${root}mobile/src/screens/HomeStatus.tsx`, 'utf8'), /<Title>MoPilot<\/Title>/);
});

test('every image app.json and app.config.js name exists with the size the store and Android require', () => {
  const expected: Record<string, { width: number; height: number; colorType: number }> = {
    [app.icon]: { width: 1024, height: 1024, colorType: 2 },
    [app.splash.image]: { width: 1024, height: 1024, colorType: 6 },
    [app.android.adaptiveIcon.foregroundImage]: { width: 1024, height: 1024, colorType: 6 },
    [app.android.adaptiveIcon.monochromeImage]: { width: 1024, height: 1024, colorType: 6 },
    [app.web.favicon]: { width: 48, height: 48, colorType: 2 },
    './assets/notification-icon.png': { width: 96, height: 96, colorType: 6 },
  };
  for (const [ref, want] of Object.entries(expected)) assert.deepEqual(pngInfo(readFileSync(assetPath(ref))), want, ref);
  const config = readFileSync(`${root}mobile/app.config.js`, 'utf8');
  assert.ok(config.includes("icon: './assets/notification-icon.png'"));
  // every generated file is wired somewhere
  assert.deepEqual(ICONS.map((i: { file: string }) => `./assets/${i.file}`).sort(), Object.keys(expected).sort());
});

test('the brand colors in the configs are the desktop icon colors', () => {
  const brand = readBrand(desktopIcon);
  assert.equal(app.splash.backgroundColor, brand.backgroundHex);
  assert.equal(app.android.adaptiveIcon.backgroundColor, brand.backgroundHex);
  assert.ok(readFileSync(`${root}mobile/app.config.js`, 'utf8').includes(`color: '${brand.glyphHex}'`));
});

test('the committed images are what the generator makes from the desktop icon, and the adaptive glyph stays in the safe zone', () => {
  const brand = readBrand(desktopIcon);
  assert.equal(brand.tileWidth, 824);
  for (const spec of ICONS) {
    const want = renderIcon(brand, spec);
    const got = decodePng(readFileSync(`${root}mobile/assets/${spec.file}`));
    assert.equal(got.width, want.width, spec.file);
    assert.ok(got.data.equals(want.data), spec.file);
  }
  // the iOS icon is opaque, and the adaptive foreground is transparent around the glyph
  assert.ok(decodePng(readFileSync(`${root}mobile/assets/icon.png`)).data.every((v: number, i: number) => i % 4 !== 3 || v === 255));
  assert.equal(decodePng(readFileSync(`${root}mobile/assets/adaptive-foreground.png`)).data[3], 0);
  const safe = ICONS.find((i: { safe?: boolean }) => i.safe);
  assert.throws(() => renderIcon(brand, { ...safe, scale: 2 }), /safe zone/);
});

test('writeIcons writes every image, and the npm script entry point prints them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mopilot-icons-'));
  const written = writeIcons(desktopIcon, join(dir, 'nested'));
  assert.deepEqual(
    written,
    ICONS.map((i: { file: string }) => i.file),
  );
  assert.equal(pngInfo(readFileSync(join(dir, 'nested', 'icon.png'))).width, 1024);
  const logged: string[] = [];
  const log = console.log;
  const argv = process.argv;
  console.log = (line: string) => logged.push(line);
  process.argv = [argv[0], 'make-icons.mjs', desktopIcon, join(dir, 'cli')];
  try {
    await import(`${scripts}make-icons.mjs?run=1`);
  } finally {
    console.log = log;
    process.argv = argv;
  }
  assert.deepEqual(logged, [written.join('\n')]);
});

test('the PNG codec round-trips RGB and RGBA, and rejects files it cannot read', () => {
  const rgba = { width: 2, height: 2, data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) };
  assert.ok(decodePng(encodePng(rgba, { alpha: true })).data.equals(rgba.data));
  assert.deepEqual([...decodePng(encodePng(rgba, { alpha: false })).data], [1, 2, 3, 255, 5, 6, 7, 255, 9, 10, 11, 255, 13, 14, 15, 255]);
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
  const good = encodePng(rgba, { alpha: true });
  const corrupt = Buffer.from(good);
  corrupt[20] ^= 0xff;
  assert.throws(() => decodePng(corrupt), /bad checksum in IHDR/);
  const rows = Buffer.alloc(2 * (8 + 1));
  assert.throws(() => decodePng(craft({ colorType: 0, rows })), /only 8-bit RGB or RGBA/);
  assert.throws(() => decodePng(craft({ depth: 16, rows })), /only 8-bit RGB or RGBA/);
  assert.throws(() => decodePng(craft({ interlace: 1, rows })), /only 8-bit RGB or RGBA/);
  rows[0] = 9;
  assert.throws(() => decodePng(craft({ rows })), /unknown PNG filter 9/);
});

test('every PNG row filter decodes to the same pixels', () => {
  // a 2x2 RGBA image whose rows are stored with each filter type in turn; the first row of each is filtered against zeros
  const px = [
    [10, 20, 30, 255, 40, 50, 60, 255],
    [70, 80, 90, 255, 100, 110, 120, 255],
  ];
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const [pa, pb, pc] = [a, b, c].map((v) => Math.abs(p - v));
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (const filter of [0, 1, 2, 3, 4]) {
    const rows: number[] = [];
    px.forEach((row, y) => {
      rows.push(filter);
      row.forEach((v, i) => {
        const left = i >= 4 ? row[i - 4] : 0;
        const up = y > 0 ? px[y - 1][i] : 0;
        const upLeft = y > 0 && i >= 4 ? px[y - 1][i - 4] : 0;
        const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
        rows.push((v - predictor) & 0xff);
      });
    });
    const decoded = decodePng(craft({ rows: Buffer.from(rows) }));
    assert.deepEqual([...decoded.data], px.flat(), `filter ${filter}`);
  }
});
