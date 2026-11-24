// Every `host.momo*` method is the owner's own devices only: for each method file of the Host, the veil of each `host.momo*` method refuses the local command line (a token beside the socket, so any process on the machine), a narrower kind of client and an unpaired connection, and lets a paired desktop and phone through. The one exception is the read-only status, which says only whether MoMo is here. A method file that adds a veil without `isOwner` fails here by method name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-ignore: plain ESM without declarations
import { codeFilesIn } from '../shared/host/methodFiles.mjs';

const DIR = path.join(import.meta.dirname, '..', 'host', 'src', 'methods');
/** Methods any paired client may call while a grant is live: what they answer reveals no MoMo data (the status says whether MoMo is here, nothing of what it holds). */
const READ_ONLY_STATUS = new Set(['host.momoStatus']);

const who = (kind: string) => ({ fingerprint: `fp-${kind}`, name: kind, kind });
/** A home that answers every question as "yes, granted, and this service is there". */
const home: any = new Proxy({}, { get: (_t, key) => (key === 'granted' ? () => true : key === 'service' ? () => ({}) : () => undefined) });

test('the veil of every host.momo* method lets the owner’s devices through and nobody else', async () => {
  const seen: string[] = [];
  const wrong: string[] = [];
  for (const name of codeFilesIn(DIR).filter((n: string) => /^momo/.test(n))) {
    const module = await import(pathToFileURL(path.join(DIR, name)).href);
    const file = module.default({ momo: home });
    for (const [method, veil] of Object.entries<any>(file.veils ?? {})) {
      if (!method.startsWith('host.momo')) continue;
      seen.push(method);
      for (const ok of ['desktop', 'phone']) if (!veil(who(ok))) wrong.push(`${method} (${name}) refuses the ${ok}`);
      for (const bad of [null, undefined]) if (veil(bad)) wrong.push(`${method} (${name}) answers an unpaired connection`);
      if (READ_ONLY_STATUS.has(method)) continue;
      for (const bad of ['cli', 'home', 'unknown'])
        if (veil(who(bad))) wrong.push(`${method} (${name}) lets the ${bad} kind in: add isOwner to its veil`);
    }
  }
  assert.deepEqual(wrong, [], 'veils that are not the owner’s only');
  assert.ok(seen.length >= 10, `read ${seen.length} veils: ${seen.join(', ')}`);
  for (const m of [
    'host.momoGrant',
    'host.momoGoogle',
    'host.momoMove',
    'host.momoRows',
    'host.momoLaneIntent',
    'host.momoTasks',
    'host.momoLink',
  ])
    assert.ok(seen.includes(m), `${m} was checked`);
});
