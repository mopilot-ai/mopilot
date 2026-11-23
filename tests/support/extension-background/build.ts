// Extension build unit cases using shared fake Chrome, socket, timer, and page fixtures.
import { test, assert, crypto, fs, path, spawnSync, build, main, tmp } from './fixture.ts';

export function registerBuild() {
  test('the build: the manifest’s key gives the id main allows; the extension is copied with the app’s version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(build.SRC, 'manifest.json'), 'utf8'));
    assert.equal(build.extensionIdOf(manifest.key), main.EXTENSION_ID);
    assert.deepEqual(build.manifestProblems(manifest, build.SRC, main.EXTENSION_ID), []);
    const out = path.join(tmp(), 'ext');
    const r = build.buildExtension({ out, version: '0.4.0-dogfood.2' });
    assert.equal(r.version, '0.4.0');
    assert.equal(r.id, main.EXTENSION_ID);
    assert.deepEqual(r.files, build.extensionFiles());
    assert.ok(r.files.includes('src/sessions.mjs'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).version, '0.4.0');
    assert.equal(
      fs.readFileSync(path.join(out, 'src/client.mjs'), 'utf8'),
      fs.readFileSync(path.join(build.SRC, 'src/client.mjs'), 'utf8'),
    );
    // the default version is the app's
    const again = build.buildExtension({ out });
    assert.match(again.version, /^\d+\.\d+\.\d+$/);
    assert.equal(build.chromeVersion('7'), '7');
    assert.throws(() => build.chromeVersion('dev'), /Can't make a Chrome extension version/);
  });

  test('the store build leaves out the key, keeps the full app version as version_name and zips what it copied', () => {
    const out = path.join(tmp(), 'store');
    const r = build.buildExtension({ out, version: '0.4.0-dogfood.2', store: true });
    assert.equal(r.id, null);
    assert.equal(r.zip, `${out}-0.4.0.zip`);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.key, undefined);
    assert.equal(manifest.version, '0.4.0');
    assert.equal(manifest.version_name, '0.4.0-dogfood.2');
    for (const size of build.ICON_SIZES) assert.ok(r.files.includes(manifest.icons[size]), size);
    const names = spawnSync('unzip', ['-Z1', r.zip], { encoding: 'utf8' });
    assert.deepEqual(names.stdout.trim().split('\n'), r.files);
    const zipped = JSON.parse(spawnSync('unzip', ['-p', r.zip, 'manifest.json'], { encoding: 'utf8' }).stdout);
    assert.deepEqual(zipped, manifest);
    // with no version given, the store build takes its own (bumped once per upload), not the app's
    const plain = build.buildExtension({ out: path.join(tmp(), 'store-default'), store: true });
    assert.equal(plain.version, build.STORE_VERSION);
    assert.equal(plain.zip, `${path.join(path.dirname(plain.out), 'store-default')}-${build.STORE_VERSION}.zip`);
    // the unpacked build keeps the key, and a plain version has no version_name
    const dev = build.buildExtension({ out: path.join(tmp(), 'dev'), version: '1.2.3' });
    const devManifest = JSON.parse(fs.readFileSync(path.join(dev.out, 'manifest.json'), 'utf8'));
    assert.equal(build.extensionIdOf(devManifest.key), main.EXTENSION_ID);
    assert.equal(devManifest.version_name, undefined);
    assert.equal(dev.zip, null);
  });

  test('the build refuses a manifest that asks for more, exposes a page, has another key or names missing files', () => {
    const src = tmp();
    fs.mkdirSync(path.join(src, 'src'));
    const good = JSON.parse(fs.readFileSync(path.join(build.SRC, 'manifest.json'), 'utf8'));
    const bad = {
      ...good,
      manifest_version: 2,
      permissions: [...good.permissions, 'cookies'],
      host_permissions: ['<all_urls>'],
      web_accessible_resources: [{ resources: ['options.html'] }],
      icons: { 16: 'icons/gone.png' },
      key: crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(bad));
    fs.writeFileSync(
      path.join(src, 'options.html'),
      '<link rel="stylesheet" href="look.css" /><link href="font.woff2" /><a href="https://x.example/">x</a><script type="module" src="nowhere.mjs"></script>',
    );
    fs.writeFileSync(path.join(src, 'look.css'), 'body {}');
    // on disk but not a file type the build packages: the page would ship without it
    fs.writeFileSync(path.join(src, 'font.woff2'), '');
    fs.writeFileSync(path.join(src, 'src', 'a.mjs'), "import x from './missing.mjs';");
    const problems = build.manifestProblems(bad, src, main.EXTENSION_ID);
    for (const p of [
      /manifest_version/,
      /permissions must be exactly/,
      /host_permissions/,
      /web-accessible/,
      /the key must give/,
      /background.mjs is missing/,
      /icons must name a 128px PNG/,
      /icons\/gone.png is missing/,
      /loads nowhere.mjs/,
      /loads .\/missing.mjs/,
      /loads font.woff2, which the build leaves out/,
    ])
      assert.ok(
        problems.some((x: string) => p.test(x)),
        String(p),
      );
    assert.throws(() => build.buildExtension({ src, out: path.join(src, 'out'), version: '1.0.0' }), /can't be built/);
    assert.deepEqual(build.manifestProblems({}, src, 'x').length > 0, true);
    assert.ok(build.manifestProblems(null, src, 'x').includes('manifest_version must be 3'));
    // a linked stylesheet is packaged; a web link is not a file
    assert.ok(!problems.some((x: string) => /look\.css|x\.example/.test(x)));
  });

  test('the build’s command line: --out, the default folder, --help', () => {
    const calls: any[] = [];
    const logs: string[] = [];
    const fake = (o: any) => {
      calls.push(o);
      return { out: o.out, version: '1.0.0', id: 'abc' };
    };
    build.cli(['--out', 'rel/out'], { build: fake, log: (s: string) => logs.push(s) });
    build.cli([], { build: fake, log: (s: string) => logs.push(s) });
    build.cli(['--out'], { build: fake, log: (s: string) => logs.push(s) });
    build.cli(['--store'], {
      build: (o: any) => (calls.push(o), { out: 'o', version: '1.0.0', id: null, zip: 'o-1.0.0.zip' }),
      log: (s: string) => logs.push(s),
    });
    build.cli(['--help'], { build: fake, log: (s: string) => logs.push(s) });
    assert.equal(calls[0].out, path.resolve('rel/out'));
    assert.equal(calls[1].out, build.OUT);
    assert.equal(calls[2].out, build.OUT);
    assert.equal(calls[3].out, build.STORE_OUT);
    assert.deepEqual([calls[1].store, calls[3].store], [false, true]);
    assert.match(logs[3], /for the Chrome Web Store: upload o-1.0.0.zip/);
    assert.match(logs[0], /Built MoPilot's Chrome extension 1.0.0 \(id abc\)/);
    assert.match(logs.at(-1) as string, /^Usage:/);
    // run as a script
    const r = spawnSync(process.execPath, [path.join(path.dirname(build.SRC), '..', 'scripts', 'build-chrome-extension.mjs'), '--help'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage:/);
  });
}
