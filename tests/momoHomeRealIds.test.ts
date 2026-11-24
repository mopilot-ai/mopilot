// A fix is a kind and its fields in one string (shared/momoFixId.mjs). A machine's own id has `:` and `@` in it (`ssh:user@host`, `ssh:host:2222`), and may have a `!` or a `%`: a fix about such a machine reaches the right machine, for every one of them, on real in-process Hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { fixId, parseFixId } from '../shared/momoFixId.mjs';
import { world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';

const STYLES: [string, (key: string) => string][] = [
  ['ssh:user@host', (k) => `ssh:runner@${k}`],
  ['ssh:host:port', (k) => `ssh:${k}.example:2222`],
  ['with ! and %', (k) => `ssh:we!ird%41${k}@host:22`],
];

test('a fix id is read back as it was built, whatever is in the fields, and one that is not well formed is nothing', () => {
  for (const f of ['studio', 'ssh:runner@localhost', 'ssh:host:2222', 'a!b%c:d', '', 'ünï:cödé'])
    assert.deepEqual(parseFixId(fixId('use-older!', 'token-1', f)), { kind: 'use-older!', fields: ['token-1', f] });
  assert.deepEqual(parseFixId('check-again'), { kind: 'check-again', fields: [] });
  assert.equal(parseFixId('use-older:%E0%A4%A'), null, 'a field that does not decode');
  assert.equal(parseFixId(42), null);
});

for (const [style, ids] of STYLES)
  test(`${style}: the older MoMo's three choices, the machine buttons, a wake, a move and a choice all reach the machine`, async (t) => {
    const w = await world(t, { second: true, ids });
    const studio = w.ids.studio;
    const mini = w.ids.mini;
    assert.equal((await w.intent({ kind: 'choose-home', machineId: studio })).ok, true);
    await w.b!.home.start({ name: 'Mac mini', floor: 1 });
    await w.real.refresh();
    await waitFor(() => w.a.home.look().holds === 'retired', 'the Studio to be retired');
    w.clock.at += 10_000;
    await w.real.refresh();
    // the card offers ids that carry the machine whole
    const card: any = ((await w.view()).problems as any[]).find((p) => p.code === 'older_home');
    assert.deepEqual(parseFixId(card.fix.id), { kind: 'use-older', fields: [studio] });
    assert.deepEqual(parseFixId(card.also[0].id), { kind: 'keep-older', fields: [studio] });
    assert.deepEqual(parseFixId(card.also[1].id), { kind: 'delete-older', fields: [studio] });
    // use: asked, then confirmed with the id the ask gave
    const use = await w.intent({ kind: 'fix', id: card.fix.id });
    assert.match(use.cause, /Use the older MoMo on Studio/);
    assert.deepEqual(parseFixId(use.fix.id)?.fields.at(-1), studio);
    assert.equal((await w.intent({ kind: 'fix', id: use.fix.id })).ok, true, 'revived through the confirmation');
    assert.equal(w.a.home.look().holds, 'home');
    // delete (of the MoMo now older, on the Mini): asked, then confirmed
    await waitFor(() => w.b!.home.look().holds === 'retired', 'the Mini to stand down');
    w.clock.at += 10_000;
    await w.real.refresh();
    const del = await w.intent({ kind: 'fix', id: fixId('delete-older', mini) });
    assert.match(del.cause, /This deletes only the older MoMo on Mac mini/);
    assert.equal((await w.intent({ kind: 'fix', id: del.fix.id })).ok, true);
    assert.equal(w.b!.home.look().holds, 'none');
    // keep, on a fresh retirement
    await w.intent({ kind: 'fix', id: fixId('keep-older', mini) });
    // the app's machine buttons: the ids the view gives, pressed as the screen presses them
    w.machines[0] = {
      ...w.machines[0],
      current: false,
      agents: [{ id: 'claude', name: 'Claude Code', installed: false, signedIn: false }],
    } as any;
    w.clock.at += 10_000;
    await w.real.refresh();
    const v = await w.view();
    const install = v.home.agentProblem.fix.id;
    assert.deepEqual(parseFixId(install), { kind: 'install-agent', fields: [studio, 'claude'] });
    assert.equal((await w.intent({ kind: 'fix', id: install })).ok, true);
    w.machines[0] = { ...w.machines[0], agents: [{ id: 'claude', name: 'Claude Code', installed: true, signedIn: false }] } as any;
    w.clock.at += 10_000;
    await w.real.refresh();
    assert.equal((await w.intent({ kind: 'fix', id: (await w.view()).home.agentProblem.fix.id })).ok, true, 'sign in');
    assert.equal((await w.intent({ kind: 'fix', id: fixId('update-machine', studio) })).ok, true, 'update');
    assert.deepEqual(
      w.acts.map((a) => [a.kind, a.machineId]),
      [
        ['install-agent', studio],
        ['sign-in-agent', studio],
        ['update-machine', studio],
      ],
    );
    // a wake of a home that sleeps, and a choice on the machine the id names
    w.down.add('studio');
    w.clock.at += 10_000;
    await w.real.refresh();
    assert.equal((await w.intent({ kind: 'wake' })).ok, true);
    assert.deepEqual(w.acts.at(-1), { kind: 'wake', machineId: studio });
  });
