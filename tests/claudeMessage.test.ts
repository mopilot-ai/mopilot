// Claude messages built in main (electron/harness/claude/message.cjs): block order for slash commands (C11),
// images the API can't take converted to PNG (D-58), selections and files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { buildClaudeMessage, readImage } = createRequire(import.meta.url)('../electron/harness/claude/message.cjs');
const img = (p: string) => ({ kind: 'image', path: p, name: path.basename(p) });
const fakeRead = (p: string) => ({ type: 'base64', media_type: 'image/png', data: `png:${path.basename(p)}` });

test('plain text stays a string', () => {
  assert.deepEqual(buildClaudeMessage({ text: '/goal tests pass' }, fakeRead), { role: 'user', content: '/goal tests pass' });
});

test('handoff first, images next, the typed text (with its slash command) last', () => {
  const m = buildClaudeMessage(
    { text: '/code-review low', attachments: [img('/s/a.png'), img('/s/b.heic')], prefix: '<sage-handoff>…</sage-handoff>' },
    fakeRead,
  );
  assert.deepEqual(
    m.content.map((b: any) => b.type + (b.type === 'text' ? `:${b.text}` : `:${b.source.data}`)),
    ['text:<sage-handoff>…</sage-handoff>', 'image:png:a.png', 'image:png:b.heic', 'text:/code-review low'],
  );
});

test('selections use the shared layout; files become @mentions; an unreadable image is named', () => {
  const m = buildClaudeMessage(
    {
      text: 'fix it',
      attachments: [{ kind: 'selection', text: 'x = 1' }, { kind: 'file', path: '/r/a.ts', name: 'a.ts' }, img('/gone.png')],
    },
    () => null,
  );
  assert.equal(typeof m.content, 'string');
  assert.match(m.content, /# Selected text:\n<selected-text>\n\["x = 1"\]\n<\/selected-text>\n\n## My request:\nfix it\n/);
  assert.match(m.content, /\n@\/r\/a\.ts/);
  assert.match(m.content, /\[gone\.png couldn't be attached\]/);
});

test('API image types are read as they are; others go through the PNG conversion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-img-test-'));
  fs.writeFileSync(path.join(dir, 'a.JPG'), 'jpeg-bytes');
  fs.writeFileSync(path.join(dir, 'b.bmp'), 'bmp-bytes');
  const converted: string[] = [];
  const convert = (f: string) => (converted.push(path.basename(f)), Buffer.from('png-bytes'));
  assert.deepEqual(await readImage(path.join(dir, 'a.JPG'), convert), {
    type: 'base64',
    media_type: 'image/jpeg',
    data: Buffer.from('jpeg-bytes').toString('base64'),
  });
  assert.deepEqual(await readImage(path.join(dir, 'b.bmp'), convert), {
    type: 'base64',
    media_type: 'image/png',
    data: Buffer.from('png-bytes').toString('base64'),
  });
  assert.deepEqual(converted, ['b.bmp']);
  assert.equal(await readImage(path.join(dir, 'c.heic'), () => null), null);
});

test('a reserved image extension follows unsupported-format conversion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reserved-image-'));
  try {
    for (const ext of ['__proto__', 'constructor']) {
      const file = path.join(dir, `image.${ext}`);
      fs.writeFileSync(file, 'raw');
      let converted = false;
      const result = await readImage(file, (p: string) => {
        assert.equal(p, file);
        converted = true;
        return Buffer.from('converted');
      });
      assert.equal(converted, true);
      assert.deepEqual(result, { type: 'base64', media_type: 'image/png', data: Buffer.from('converted').toString('base64') });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
