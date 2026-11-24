// A Host that is not MoMo's running home acts for it in nothing, whichever way it came to be one: MoMo moved away (a tombstone), a move under way, a Host that never made a home, or a grant that has run out. Whole-repo: it enumerates EVERY `host.momo*` handler of host/src/methods, calls each one that is not on the explicit off-home list with minimal parameters, and holds that it refuses (never answers, empty or not), that nothing it was seeded with comes back, and that no file or key appears in MoMo's folder or the config folder. (The source scan at the end is a lint of the text, not a proof.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { codeFilesIn } from '../shared/host/methodFiles.mjs';
// @ts-ignore
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';
// @ts-ignore
import { OFF_HOME_OK } from '../host/src/momoHomeGuard.mjs';
// @ts-ignore
import { collectHandlers } from '../host/src/methodHandlers.mjs';

const req = createRequire(import.meta.url);
const DIR = path.join(import.meta.dirname, '..', 'host', 'src', 'methods');
const SECRET = 'a-private-line-seeded-by-the-test';
/** The causes a Host that is not the home may give. */
const REFUSALS = new Set(['momo_home_away', 'momo_grant_lapsed', 'momo_unavailable', 'not_home']);
const who = { principal: () => ({ fingerprint: 'fp-desktop', name: 'Mac', kind: 'desktop' }) };

const listing = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
        .sort()
    : [];

async function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-nothome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map<string, any>();
  const sessions: any = {
    chats: { records, patchMeta: (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } }) },
    isolated: () => true,
    isolate: () => undefined,
  };
  const home: any = momoHomeFor({
    paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
    report: () => undefined,
    sessions,
    epochs: { current: () => 1 } as any,
    hidden: createMomoHidden(),
    hostId: 'home-aaaa-1111',
    env: { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' },
  });
  t.after(() => home.close());
  return { dir, home };
}

/** Every handler of the MoMo method files, as the Host's collector serves them (guard included). */
async function handlersOf(home: any) {
  const names = codeFilesIn(DIR).filter((n: string) => /^momo/.test(n));
  const handlers = collectHandlers(names, (f: string) => req(path.join(DIR, f)), {
    momo: home,
    report: () => undefined,
  });
  return handlers;
}

for (const how of ['moved away', 'moving', 'never a home'] as const) {
  test(`${how}: every host.momo* handler that is not on the off-home list refuses, answers none of the seeded data and creates no file or key`, async (t) => {
    const { dir, home } = await world(t);
    await home.grant({ account: 'a1', features: ['momo'] });
    if (how !== 'never a home') {
      await home.start({ name: 'Studio' });
      await home.stores().memory.save({ text: SECRET, source: 'user' });
      await home.service('notes')?.seed?.();
      if (how === 'moved away') await home.tombstone({ name: 'Mini', homeId: 'zz', leaseEpoch: 5 });
      else await home.swap(home.record().leaseEpoch, (r: any) => ((r.state = 'moving'), (r.moveId = 'm1'), false));
    }
    const { handlers } = await handlersOf(home);
    const data = path.join(dir, 'data', 'momo');
    const config = path.join(dir, 'config');
    const before = [listing(data), listing(config)];
    const checked: string[] = [];
    for (const [method, run] of Object.entries<any>(handlers)) {
      if (!method.startsWith('host.momo') || OFF_HOME_OK.includes(method)) continue;
      checked.push(method);
      const answer = await (async () => (run as any)({}, 'request', who))().then(
        (value) => ({ value }),
        (error: any) => ({ code: error?.code ?? error?.name }),
      );
      assert.ok(
        'code' in answer && REFUSALS.has(answer.code as string),
        `${how}: ${method} ${'code' in answer ? `refused with ${answer.code}` : `answered ${JSON.stringify(answer.value)?.slice(0, 80)}`}`,
      );
    }
    assert.ok(checked.length >= 12, `checked ${checked.length} handlers: ${checked.join(', ')}`);
    assert.deepEqual([listing(data), listing(config)], before, `${how}: a handler created a file or a key`);
  });
}

test('a lapsed grant is its own cause, not "the home is not running"', async (t) => {
  const { home } = await world(t);
  await home.grant({ account: 'a1', features: ['momo'] });
  await home.start({ name: 'Studio' });
  const { handlers } = await handlersOf(home);
  const granted = home.granted;
  home.granted = () => false;
  const refused = await (async () => (handlers['host.momoPrefs'] as any)({}, 'request', who))().catch((e: any) => e.code);
  home.granted = granted;
  assert.equal(refused, 'momo_grant_lapsed');
});

test('the off-home list names only methods that exist, and every method file’s handlers are all either on it or behind the guard', async (t) => {
  const { home } = await world(t);
  const { handlers } = await handlersOf(home);
  const momo = Object.keys(handlers).filter((m) => m.startsWith('host.momo'));
  for (const m of OFF_HOME_OK) assert.ok(momo.includes(m), `${m} is on the list but no handler serves it`);
  // lint of the text: no file of the methods folder hands out a handler around the guard
  for (const f of codeFilesIn(DIR).filter((n: string) => /^momo/.test(n)))
    assert.match(fs.readFileSync(path.join(DIR, f), 'utf8'), /guard: onlyAtHome\(momo\)/, `${f} does not guard its handlers`);
});

test('a Host with no MoMo at all serves no MoMo handler: the guard refuses every one, the off-home few too', async () => {
  // @ts-ignore: plain ESM without declarations
  const { onlyAtHome } = await import('../host/src/momoHomeGuard.mjs');
  for (const method of ['host.momoStatus', 'host.momoPrefs', 'host.momoGrant']) {
    let ran = false;
    const wrapped = onlyAtHome(undefined)(method, () => ((ran = true), 'data'));
    assert.throws(wrapped, (e: any) => e.code === 'momo_home_away');
    assert.equal(ran, false, `${method} must not run`);
  }
});
