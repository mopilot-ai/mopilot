// What a Host that starts as the home keeps with the Host's own key: Google's owed revokes settle through the Host's own folder reached by NAME (the services' view of the home hides the Host key), and no service reads the Host key's storage directly. (That a Host that is not the home refuses every method is tests/hostMomoNotHome.invariant.test.ts.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';

async function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-not-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map<string, any>();
  const sessions: any = {
    chats: { records, patchMeta: (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } }) },
    isolated: () => true,
    isolate: () => undefined,
  };
  const reports: string[] = [];
  const home: any = momoHomeFor({
    paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
    report: (m: string) => reports.push(m),
    sessions,
    epochs: { current: () => 1 } as any,
    hidden: createMomoHidden(),
    hostId: 'home-aaaa-1111',
    env: { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' },
  });
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: ['momo'] });
  await home.start({ name: 'Studio' });
  return { home, reports };
}
test('a Host that starts as the home settles Google’s owed revokes without a report: the owed file is reached through the Host’s own folder by name', async (t) => {
  const { home, reports } = await world(t);
  await home.lifecycle('pause');
  await home.lifecycle('start');
  assert.deepEqual(
    reports.filter((r) => /Google revoke|reading 'dir'/.test(r)),
    [],
  );
  assert.equal(typeof home.hostOwnStorage, 'function');
  assert.throws(() => home.hostOwnStorage('chats.json'), /not a file a service may keep/);
  assert.ok(home.hostOwnStorage('google-revoke-owed.json').dir);
});

test('LINT (a scan of the source text, not a proof): only the home’s own parts read the Host key’s storage; no service does (the services’ view of the home does not have it)', () => {
  const root = path.join(import.meta.dirname, '..', 'host', 'src');
  const files = [
    ...fs.readdirSync(root).filter((n) => /^momo.*\.mjs$/.test(n)),
    ...fs
      .readdirSync(path.join(root, 'momoServices'))
      .filter((n) => n.endsWith('.mjs'))
      .map((n) => path.join('momoServices', n)),
  ];
  const readers = files.filter((f) => /hostOnlyStorage/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(readers.sort(), ['momoChats.mjs', 'momoHome.mjs', 'momoWiring.mjs']);
});
