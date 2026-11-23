// electron/platform/ports/electronApi.cjs: Electron's main-process API in Electron, and in a process without it (the
// Host, a script) null, with an empty API whose destructured members are undefined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const file = fileURLToPath(new URL('../electron/platform/ports/electronApi.cjs', import.meta.url));
const source = fs.readFileSync(file, 'utf8');

function load(electron: unknown) {
  const module = { exports: {} as any };
  vm.runInNewContext(
    source,
    {
      module,
      require: (id: string) => {
        assert.equal(id, 'electron');
        if (electron instanceof Error) throw electron;
        return electron;
      },
    },
    { filename: file },
  );
  return module.exports;
}

test('in Electron the port gives its API, as is and to destructure', () => {
  const electron = { app: { name: 'MoPilot' } };
  const port = load(electron);
  assert.equal(port.electron, electron);
  assert.equal(port.api, electron);
});

test('without Electron the port is null and its API empty: a destructured member is undefined, never a throw', () => {
  const port = load(new Error("Cannot find module 'electron'"));
  assert.equal(port.electron, null);
  const { app, dialog } = port.api;
  assert.equal(app, undefined);
  assert.equal(dialog, undefined);
});
