// Panel admission recovers native grouping failures without replacing user groups or acknowledging retired receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/chrome-membership-kit.mjs';
async function setup(t: any, memberships = true) {
  const w = world({ memberships });
  const get = w.chrome.tabs.get;
  w.chrome.tabs.get = async (id: number) => structuredClone(await get(id));
  t.after(() => w.tabs.dispose());
  const link = await w.relay.connect('a');
  const tab = w.chrome.addTab({ url: 'https://example.org/form' });
  return { ...w, tab, link };
}

test('legacy clients, a different receiving chat, and expired queued grants cannot claim a page', async (t) => {
  const old = await setup(t, false);
  await assert.rejects(old.link.send('session.adopt', [await old.sessions.admissions.offer(old.tab.id)]), /Update/);
  const w = await setup(t);
  await assert.rejects(w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id, Date.now(), 'b')]), /expired/);
  const offered = await w.sessions.admissions.offer(w.tab.id);
  const now = Date.now();
  const later = t.mock.method(Date, 'now', () => now + 120_000);
  await assert.rejects(w.sessions.admissions.panel('a', w.sessions.chats.get('a'), offered, now), /expired/);
  later.mock.restore();
  await w.sessions.admissions.offer(w.tab.id, now + 180_000);
  assert.equal(w.sessions.admissions.grants.has(offered.grant), false);
});

test('a missed native group event and a reentrant release during reporting cannot return successful ownership', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const offered = await w.sessions.admissions.offer(w.tab.id);
  w.tab.groupId = -1;
  await assert.rejects(w.link.send('session.adopt', [offered]), /left its chat/);
  assert.equal(w.sessions.owner.has(w.tab.id), false);
  const report = w.sessions.admissions.ops.report;
  w.sessions.admissions.ops.report = (...args: any[]) => {
    report(...args);
    w.move(w.tab.id, -1);
  };
  await assert.rejects(w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]), /left the chat/);
  assert.equal(w.relay.owns('a', w.tab.id), false);
  assert.throws(() => w.sessions.admissions.assertReceipt('session.adopt', null, true), /retired/);
});

for (const deleted of [false, true]) {
  test(`a retired move restores a ${deleted ? 'deleted' : 'surviving'} user group and its metadata`, async (t) => {
    const w = await setup(t);
    const initial = await w.chrome.tabs.group({ tabIds: [w.tab.id] });
    await w.chrome.tabGroups.update(initial, { title: 'My bookings', color: 'green' });
    const grant = await w.sessions.admissions.offer(w.tab.id);
    const group = w.chrome.tabs.group;
    let first = true;
    w.chrome.tabs.group = async (args: any) => {
      const id = await group(args);
      w.sessions.onTabUpdated(w.tab.id, { groupId: id }, { ...w.tab });
      if (first) {
        first = false;
        if (deleted) w.chrome.groups.delete(initial);
        await w.sessions.close('a');
      }
      return id;
    };
    await assert.rejects(w.link.send('session.adopt', [grant]), /expired|changed/);
    assert.equal(w.sessions.owner.has(w.tab.id), false);
    const restored = w.chrome.groups.get(w.tab.groupId);
    assert.equal(restored.title, 'My bookings');
    assert.equal(restored.color, 'green');
    if (!deleted) assert.equal(w.tab.groupId, initial);
  });
}

test('native group metadata and rollback read failures are visible and never invent a successful admission', async (t) => {
  const w = await setup(t);
  await w.chrome.tabs.group({ tabIds: [w.tab.id] });
  const grant = await w.sessions.admissions.offer(w.tab.id);
  w.chrome.fail['tabGroups.get'] = new Error('Group disappeared');
  await assert.rejects(w.link.send('session.adopt', [grant]), /tab group changed/);
  delete w.chrome.fail['tabGroups.get'];
  const second = await w.sessions.admissions.offer(w.tab.id);
  const group = w.chrome.tabs.group;
  w.chrome.tabs.group = async (args: any) => {
    const id = await group(args);
    await w.sessions.close('a');
    w.chrome.fail['tabs.get'] = new Error('Tab closed');
    return id;
  };
  const logs: string[] = [];
  w.sessions.log = (what: string) => logs.push(what);
  await assert.rejects(w.link.send('session.adopt', [second]), /expired|changed/);
  assert.ok(logs.includes('restore a panel tab after its transfer failed'));
  assert.ok(logs.includes('read a panel tab after its group move'));
});

test('a native operation returning after its grant expires rolls back, while retries get an immediate pending outcome', async (t) => {
  const w = await setup(t);
  const offered = await w.sessions.admissions.offer(w.tab.id);
  const now = Date.now();
  let release: any;
  const group = w.chrome.tabs.group;
  w.chrome.tabs.group = async (args: any) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return group(args);
  };
  const pending = w.link.send('session.adopt', [offered]);
  await new Promise((resolve) => setImmediate(resolve));
  const later = t.mock.method(Date, 'now', () => now + 120_000);
  const next = await w.sessions.admissions.offer(w.tab.id);
  await assert.rejects(w.link.send('session.adopt', [next]), /still finishing an earlier/);
  release();
  await assert.rejects(pending, /expired|changed/);
  assert.equal(w.tab.groupId, -1);
  assert.equal(w.sessions.owner.has(w.tab.id), false);
  later.mock.restore();
});

test('a native group acknowledgment after the real main transport timeout restores the original owner', async (t) => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { preparePanelTab } = require('../electron/capabilities/browser/chromePanelTab.cjs');
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const other = await w.relay.connect('b');
  other.commandMs = 30;
  const grant = await w.sessions.admissions.offer(w.tab.id);
  const group = w.chrome.tabs.group;
  let release: any,
    first = true;
  w.chrome.tabs.group = async (args: any) => {
    if (first) {
      first = false;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return group(args);
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const live = {
    chromeRelay: { kind: 'extension', relay: w.relay, tabs: w.tabs },
    controllerPlans: { snapshot: () => ({ key: 'b', plan: { bu: 'mopilot-chrome' } }) },
    sessions: { running: () => false },
  };
  const pending = preparePanelTab(live, 'b', 'Read this', grant);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  t.mock.timers.tick(30);
  const response = await pending;
  assert.match(response.warning, /could not be connected/);
  assert.equal(response.target, undefined);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.sessions.owner.get(w.tab.id), 'a');
  assert.equal(w.tab.groupId, w.sessions.chats.get('a')!.groupId);
  assert.deepEqual(w.ids('b'), []);
});

test('unused grants expire, and a native tab read returning after expiry cannot start a group mutation', async (t) => {
  const w = await setup(t);
  const old = await w.sessions.admissions.offer(w.tab.id, 0);
  await w.sessions.admissions.offer(w.tab.id, 60_000);
  assert.equal(w.sessions.admissions.grants.has(old.grant), false);
  const grant = await w.sessions.admissions.offer(w.tab.id);
  const get = w.chrome.tabs.get;
  let finish: any;
  w.chrome.tabs.get = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = w.link.send('session.adopt', [grant]);
  await new Promise((resolve) => setImmediate(resolve));
  const later = t.mock.method(Date, 'now', () => Date.parse('2099-01-01'));
  finish({ ...w.tab });
  await assert.rejects(pending, /grant expired/);
  later.mock.restore();
  w.chrome.tabs.get = get;
  assert.equal(w.tab.groupId, -1);
});

test('a created tab’s late native group acknowledgment cannot resurrect its closed session', async (t) => {
  const w = await setup(t);
  const group = w.chrome.tabs.group;
  let release: any;
  w.chrome.tabs.group = async (args: any) => {
    const id = await group(args);
    await new Promise((resolve) => {
      release = resolve;
    });
    return id;
  };
  const pending = w.link.send('chrome.tabs.create', [{ url: 'https://example.org/created' }]);
  await new Promise((resolve) => setImmediate(resolve));
  await w.sessions.close('a');
  release();
  await assert.rejects(pending, /retired|closed|no longer/);
  assert.deepEqual(w.ids('a'), []);
  const created = [...w.chrome.tabsById.values()].find((tab: any) => tab.url === 'https://example.org/created');
  assert.ok(created);
  assert.equal(created.groupId, -1);
});

for (const changed of ['url', 'group', 'session'])
  test(`the final native read refuses a changed ${changed} without substituting another page`, async (t) => {
    const w = await setup(t);
    const grant = await w.sessions.admissions.offer(w.tab.id);
    const group = w.chrome.tabs.group;
    w.chrome.tabs.group = async (args: any) => {
      const id = await group(args);
      if (changed === 'url') w.tab.url = 'https://example.org/replaced';
      if (changed === 'group') w.tab.groupId = -1;
      return id;
    };
    if (changed === 'session') {
      const get = w.chrome.tabs.get;
      let reads = 0;
      w.chrome.tabs.get = async (id: number) => {
        if (++reads === 2) await w.sessions.close('a');
        return get(id);
      };
    }
    await assert.rejects(w.link.send('session.adopt', [grant]), /changed|expired/);
    assert.equal(w.sessions.owner.has(w.tab.id), false);
  });

test('closing the previous owner during a native move cannot leave its page in a now-unacknowledged group', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const other = await w.relay.connect('b');
  const grant = await w.sessions.admissions.offer(w.tab.id);
  const group = w.chrome.tabs.group;
  let release: any;
  w.chrome.tabs.group = async (args: any) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return group(args);
  };
  const pending = other.send('session.adopt', [grant]);
  await new Promise((resolve) => setImmediate(resolve));
  await w.sessions.close('a');
  release();
  await assert.rejects(pending, /changed|expired/);
  assert.equal(w.sessions.owner.has(w.tab.id), false);
  assert.equal(w.tab.groupId, -1);
});

test('a user move while group metadata waits takes precedence over transfer rollback', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const c = await w.relay.connect('c');
  const root = await c.send('chrome.tabs.create', [{}]);
  const b = await w.relay.connect('b');
  const grant = await w.sessions.admissions.offer(w.tab.id);
  let release: any;
  w.chrome.tabGroups.update = async () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = b.send('session.adopt', [grant]);
  await new Promise((resolve) => setImmediate(resolve));
  w.move(w.tab.id, root.groupId);
  release();
  await assert.rejects(pending, /changed|expired/);
  assert.equal(w.sessions.owner.get(w.tab.id), 'c');
  assert.equal(w.tab.groupId, root.groupId);
  assert.ok(w.ids('c').includes(w.tab.id));
});

test('a user move during rollback’s group lookup cannot be overwritten by its older user-group snapshot', async (t) => {
  const w = await setup(t);
  const userGroup = await w.chrome.tabs.group({ tabIds: [w.tab.id] });
  const c = await w.relay.connect('c');
  const root = await c.send('chrome.tabs.create', [{}]);
  const grant = await w.sessions.admissions.offer(w.tab.id);
  const group = w.chrome.tabs.group,
    get = w.chrome.tabGroups.get;
  let restoring = false;
  w.chrome.tabs.group = async (args: any) => {
    const id = await group(args);
    await w.sessions.close('a');
    restoring = true;
    return id;
  };
  w.chrome.tabGroups.get = async (id: number) => {
    if (restoring && id === userGroup) w.move(w.tab.id, root.groupId);
    return get(id);
  };
  await assert.rejects(w.link.send('session.adopt', [grant]), /changed|expired/);
  assert.equal(w.sessions.owner.get(w.tab.id), 'c');
  assert.equal(w.tab.groupId, root.groupId);
});

test('a native invalid group acknowledgment cannot be reconciled into successful ownership', async (t) => {
  const w = await setup(t);
  w.chrome.tabs.group = async () => -1;
  await assert.rejects(w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]), /could not move/);
  assert.equal(w.sessions.owner.has(w.tab.id), false);
  assert.equal(w.tab.groupId, -1);
});
