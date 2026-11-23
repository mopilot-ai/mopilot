// A screen reaches its computer through useOwnedRequest, never by binding ownedRequest once at mount: a screen that stays up while its computer goes away and comes back would keep the offline snapshot it was drawn under, and every read after that is refused as another computer's (the chat's model pill and ⋯ settings never came back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Source files that call `ownedRequest(` themselves; only its definition and the hook that binds it to the connection may. */
export function bindOnceCallers(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([file]) => !/(?:^|\/)remote\/(?:client|useOwnedRequest)\.ts$/.test(file))
    .filter(([, source]) => /\bownedRequest\(/.test(withoutComments(source)))
    .map(([file]) => file);
}

test('no screen binds its way to the computer once at mount', () => {
  const sources = Object.fromEntries(files('mobile/src').map((file) => [file, readFileSync(file, 'utf8')]));
  assert.deepEqual(bindOnceCallers(sources), []);
});

test('the scan names a screen that binds it once, and passes the hook, its definition and a comment', () => {
  const bound = 'const request = useMemo(() => ownedRequest(runtime), [runtime]);';
  assert.deepEqual(bindOnceCallers({ 'mobile/src/screens/A.tsx': bound }), ['mobile/src/screens/A.tsx']);
  assert.deepEqual(bindOnceCallers({ 'mobile/src/screens/B.tsx': 'const [request] = useState(() => ownedRequest(runtime));' }), [
    'mobile/src/screens/B.tsx',
  ]);
  assert.deepEqual(bindOnceCallers({ 'mobile/src/screens/C.tsx': 'const request = useOwnedRequest(runtime);' }), []);
  assert.deepEqual(
    bindOnceCallers({
      'mobile/src/remote/useOwnedRequest.ts': bound,
      'mobile/src/remote/client.ts': 'export function ownedRequest(runtime) {}\nownedRequest(r);',
    }),
    [],
  );
  assert.deepEqual(bindOnceCallers({ 'mobile/src/screens/D.tsx': '// ownedRequest(runtime) was bound here\n/* ownedRequest( */' }), []);
});
