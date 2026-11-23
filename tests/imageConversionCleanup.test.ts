// Image conversion keeps decoded bytes when private scratch cleanup fails; every external boundary is in memory.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const file = fileURLToPath(new URL('../electron/harness/claude/message.cjs', import.meta.url));
const source = readFileSync(file, 'utf8');
const png = Buffer.from('converted-png');
const cleanupError = Object.assign(new Error('temporary directory is busy'), { code: 'EBUSY' });

function fixture({ platform = 'darwin', cleanupFails = true, sipsFails = false, nativeFails = false } = {}) {
  const cleanup: { file: string; options: object }[] = [];
  const diagnostics: { context: string; error: unknown }[] = [];
  const decoders: string[] = [];
  const identity = (text: string) => text;
  const modules: Record<string, unknown> = {
    '../../platform/ports/fs.cjs': {
      fs: {
        promises: {
          mkdtemp: async () => '/memory/sage-img-owned',
          readFile: async () => png,
          rm: async (file: string, options: object) => {
            cleanup.push({ file, options });
            if (cleanupFails) throw cleanupError;
          },
        },
      },
    },
    'node:os': { tmpdir: () => '/memory' },
    'node:path': path,
    '../../platform/ports/proc.cjs': {
      proc: {
        execFile: (_bin: string, _args: string[], _opts: object, done: (error: Error | null) => void) => {
          decoders.push('sips');
          done(sipsFails ? new Error('sips cannot decode') : null);
        },
      },
    },
    '../../platform/ports/electronApi.cjs': {
      electron: {
        nativeImage: {
          createFromPath: () => {
            decoders.push('native');
            return { isEmpty: () => nativeFails, toPNG: () => png };
          },
        },
      },
    },
    '../../ignored.cjs': { noteIgnored: (context: string, error: unknown) => diagnostics.push({ context, error }) },
    '../../../shared/ownTable.mjs': { ownTable: (table: object) => Object.assign(Object.create(null), table) },
    '../../../shared/selections.mjs': { withSelections: identity },
    '../../../shared/tabMentions.mjs': { withTabMentions: identity },
    '../../../shared/chatReferences.mjs': { withChatReferences: identity },
    '../../../shared/computerHistory.mjs': { withComputerHistory: identity },
    '../../../shared/momoContext.mjs': { withMomoContext: identity },
  };
  const module = { exports: {} as any };
  vm.runInNewContext(
    source,
    {
      require: (id: string) => {
        assert.ok(Object.hasOwn(modules, id), `Unexpected external dependency: ${id}`);
        return modules[id];
      },
      module,
      Buffer,
      Promise,
      process: { platform },
    },
    { filename: file },
  );
  return { api: module.exports, cleanup, diagnostics, decoders };
}

for (const platform of ['darwin', 'linux']) {
  test(`decoded image survives scratch cleanup failure on ${platform}`, async () => {
    const f = fixture({ platform });
    assert.equal((await f.api.readImage('/memory/photo.heic')).data, png.toString('base64'));
    assert.equal(f.cleanup.length, 1);
    assert.equal(f.cleanup[0].file, '/memory/sage-img-owned');
    assert.equal(JSON.stringify(f.cleanup[0].options), '{"recursive":true,"force":true}');
    assert.deepEqual(f.decoders, platform === 'darwin' ? ['sips'] : ['native']);
    assert.deepEqual(f.diagnostics, [{ context: 'remove a temporary converted image', error: cleanupError }]);
  });
}

test('sips failure still uses the native fallback despite failed cleanup', async () => {
  const f = fixture({ sipsFails: true });
  assert.equal((await f.api.readImage('/memory/photo.bmp')).data, png.toString('base64'));
  assert.deepEqual(f.decoders, ['sips', 'native']);
});

test('Claude and ACP receive the converted image after cleanup fails', async () => {
  const f = fixture();
  const message = await f.api.claudeMessage({ text: 'describe', attachments: [{ kind: 'image', path: '/memory/photo.tiff' }] });
  assert.equal(message.content[0].type, 'image');
  assert.equal(message.content[0].source.data, png.toString('base64'));
  assert.equal(await f.api.imageDataUrl('/memory/photo.tiff'), `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(f.cleanup.length, 2);
  assert.equal(f.diagnostics.length, 2);
});

test('successful cleanup attempts removal and produces no diagnostic', async () => {
  const f = fixture({ cleanupFails: false });
  assert.equal((await f.api.readImage('/memory/photo.heic')).data, png.toString('base64'));
  assert.equal(f.cleanup.length, 1);
  assert.deepEqual(f.diagnostics, []);
});

for (const cleanupFails of [false, true]) {
  test(`actual conversion failure remains null with cleanupFails=${cleanupFails}`, async () => {
    const f = fixture({ sipsFails: true, nativeFails: true, cleanupFails });
    assert.equal(await f.api.readImage('/memory/photo.heic'), null);
    assert.equal(await f.api.imageDataUrl('/memory/photo.heic'), null);
    assert.equal(f.cleanup.length, 2);
    assert.equal(f.diagnostics.length, cleanupFails ? 2 : 0);
  });
}
