// The unit tests' TSX loader (tests/support/register.ts): a file whose nearest tsconfig extends a package the root
// install lacks (the mobile app's extends Expo's, #2845) compiles with the repository's tsconfig, and any other compile
// error still throws with the file's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileTsx } from './support/register.ts';

test('a tsconfig extending a package that is not installed falls back to the root tsconfig; a broken file still throws', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-tsx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ extends: 'not-an-installed-package/tsconfig.base' }));
  const file = path.join(dir, 'App.tsx');
  const out = compileTsx('export const App = () => <div title="x" />;', file);
  assert.match(out, /react\/jsx-runtime/);
  assert.match(out, /sourceMappingURL=data:application\/json;base64,/);
  assert.throws(() => compileTsx('export const = ;', file), /App\.tsx/);
  // a file under a tsconfig that loads compiles with it, as before
  assert.match(compileTsx('export const B = () => <span />;', path.join(process.cwd(), 'src', 'B.tsx')), /react\/jsx-runtime/);
});
