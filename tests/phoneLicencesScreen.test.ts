// The Licences page: a row per copied-code holder with its licence, the notice behind it, and one back from each level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/phone/register.ts';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
const screenPath = '../mobile/src/ui/licences/LicencesScreen';
const rowsPath = '../mobile/src/ui/licences/licenceRows';
const { LicencesScreen } = await import(screenPath);
const { licenceRows } = await import(rowsPath);

const entry = (id: string, notice: string) => ({ id, name: id.toUpperCase(), holder: `${id} Inc.`, licence: 'MIT', source: 's', notice });

test('a row names the code, its holder and licence; an entry with no notice has none', () => {
  const rows = licenceRows([entry('a', '  Permission is hereby granted.  '), entry('b', '   ')]);
  assert.deepEqual(rows, [{ id: 'a', title: 'A (a Inc.)', detail: 'MIT', notice: 'Permission is hereby granted.' }]);
  const real = JSON.parse(readFileSync('mobile/src/licences.json', 'utf8')).entries;
  assert.ok(licenceRows(real).some((r: any) => r.title === 'Orca (Lovecast Inc.)'));
});

let mounted: { root: any; host: HTMLElement } | null = null;
test.afterEach(async () => {
  if (mounted) await act(async () => mounted!.root.unmount());
  mounted?.host.remove();
  mounted = null;
});
async function draw(rows: any[], back: () => void) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(createElement(LicencesScreen, { rows, back })));
  await flush();
  return host;
}

test('a row opens its notice; Back goes to the list first and leaves the page second', async () => {
  let left = 0;
  const host = await draw(licenceRows([entry('orca', 'The notice text.')]), () => left++);
  assert.match(host.textContent!, /Licences/);
  assert.match(host.textContent!, /ORCA \(orca Inc\.\).*MIT/);
  await click('ORCA (orca Inc.), MIT');
  assert.match(host.textContent!, /The notice text\./);
  await click('Back');
  assert.equal(left, 0);
  assert.doesNotMatch(host.textContent!, /The notice text\./);
  assert.match(host.textContent!, /ORCA/);
  await click('Back');
  assert.equal(left, 1);
});

test('with nothing to show the page says so', async () => {
  const host = await draw([], () => {});
  assert.match(host.textContent!, /No notices/);
});
