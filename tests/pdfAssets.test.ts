// PDF CMaps, fonts, ICCs and decoder binaries are copied together and development serving stays within their folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyPdfAssets, pdfAssetsPlugin, pdfResource, PDF_RESOURCE_FOLDERS } from '../scripts/pdf-assets.mjs';

test('resource copying preserves every family and its license notices', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-assets-'));
  try {
    const source = path.join(root, 'source'),
      output = path.join(root, 'output');
    for (const folder of PDF_RESOURCE_FOLDERS) {
      fs.mkdirSync(path.join(source, folder), { recursive: true });
      fs.writeFileSync(path.join(source, folder, 'LICENSE'), `${folder} license`);
    }
    copyPdfAssets(output, source);
    for (const folder of PDF_RESOURCE_FOLDERS)
      assert.equal(fs.readFileSync(path.join(output, 'preview/pdf', folder, 'LICENSE'), 'utf8'), `${folder} license`);
    assert.throws(() => copyPdfAssets(path.join(root, 'bad-output'), path.join(root, 'absent')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the production bundle hook includes actual PDF CMaps, fonts, WASM, fallback JavaScript and ICC resources', () => {
  const plugin = pdfAssetsPlugin();
  plugin.writeBundle();
  for (const file of [
    'cmaps/UniJIS-UTF16-H.bcmap',
    'wasm/jbig2.wasm',
    'wasm/jbig2_nowasm_fallback.js',
    'wasm/openjpeg.wasm',
    'wasm/openjpeg_nowasm_fallback.js',
    'iccs/CGATS001Compat-v2-micro.icc',
    'standard_fonts/FoxitSerif.pfb',
  ])
    assert.ok(fs.statSync(path.resolve('dist/preview/pdf', file)).size > 0, file);
});

test('resource paths are bounded to known families and use the correct MIME types', () => {
  assert.equal(pdfResource('/wasm/openjpeg.wasm')?.type, 'application/wasm');
  assert.equal(pdfResource('/wasm/openjpeg_nowasm_fallback.js')?.type, 'text/javascript');
  assert.equal(pdfResource('/cmaps/UniJIS-UTF16-H.bcmap?v=1')?.type, 'application/octet-stream');
  assert.equal(pdfResource('/cmaps/a.bcmap', '/tmp/resources')?.file, '/tmp/resources/cmaps/a.bcmap');
  for (const value of ['/../../private', '/other/file', '/cmaps/..', '/wasm/.', '/cmaps/a/b', '/cmaps/%2e%2e'])
    assert.equal(pdfResource(value), null, value);
});

test('the development middleware serves local resources, reports missing files and passes unrelated paths through', async () => {
  let serve!: Function;
  pdfAssetsPlugin().configureServer({
    middlewares: {
      use: (prefix: string, handler: Function) => {
        assert.equal(prefix, '/preview/pdf');
        serve = handler;
      },
    },
  });
  let passed = false;
  serve({ url: '/bad/private' }, {}, () => {
    passed = true;
  });
  assert.equal(passed, true);
  for (const [url, status] of [
    ['/cmaps/UniJIS-UTF16-H.bcmap', 200],
    ['/wasm/missing.wasm', 404],
  ] as const) {
    const result = await new Promise<{ code: number; body: Buffer | undefined; type: string }>((resolve) => {
      const response = {
        statusCode: 200,
        type: '',
        setHeader: (_key: string, value: string) => {
          response.type = value;
        },
        end: (body?: Buffer) => resolve({ code: response.statusCode, body, type: response.type }),
      };
      serve({ url }, response, () => assert.fail('resource was not handled'));
    });
    assert.equal(result.code, status);
    if (status === 200) {
      assert.ok(result.body!.length > 0);
      assert.equal(result.type, 'application/octet-stream');
    }
  }
});
