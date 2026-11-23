// Side-panel Send hands over exactly its existing tab: real Sessions and host over the in-memory membership transport, with one-use grants and ownership races.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './support/chrome-membership-kit.mjs';

async function setup(t: any) {
  const w = world();
  const get = w.chrome.tabs.get;
  w.chrome.tabs.get = async (id: number) => structuredClone(await get(id));
  t.after(() => w.tabs.dispose());
  const link = await w.relay.connect('a');
  const tab = w.chrome.addTab({ url: 'https://example.org/form', title: 'Unsaved form' });
  return { ...w, link, tab };
}

test('the exact panel tab joins the chat without creating or navigating a tab', async (t) => {
  const w = await setup(t);
  const offered = await w.sessions.admissions.offer(w.tab.id);
  const before = w.chrome.tabsById.size;
  const result = await w.link.send('session.adopt', [offered]);
  assert.equal(result.id, w.tab.id);
  assert.equal(w.chrome.tabsById.size, before);
  assert.equal(w.sessions.owner.get(w.tab.id), 'a');
  assert.equal(w.relay.owns('a', w.tab.id, result.membership), true);
  const owned = w.tabs.list('a');
  assert.equal(owned.length, 1);
  assert.equal(owned[0].wc.tabId, w.tab.id);
  assert.equal(owned[0].openedByAgent, false);
  assert.ok(!w.chrome.log.some(([method]: any) => method === 'tabs.update'));
  await assert.rejects(w.link.send('session.adopt', [offered]), /expired/);
});

test('expired, missing, wrong-tab and non-web grants never claim a tab', async (t) => {
  const w = await setup(t);
  await assert.rejects(w.sessions.admissions.offer(-1), /no Chrome tab/);
  w.tab.url = 'chrome://settings/';
  await assert.rejects(w.sessions.admissions.offer(w.tab.id), /web page/);
  w.tab.url = 'https://example.org/';
  const grant = await w.sessions.admissions.offer(w.tab.id, 0);
  const session = w.sessions.chats.get('a');
  await assert.rejects(w.sessions.admissions.panel('a', session, grant, 60_000), /expired/);
  await assert.rejects(w.sessions.admissions.panel('a', session, null), /expired/);
  const wrong = await w.sessions.admissions.offer(w.tab.id);
  await assert.rejects(w.link.send('session.adopt', [{ ...wrong, id: w.tab.id + 1 }]), /expired/);
  assert.equal(w.sessions.owner.has(w.tab.id), false);
});

test('a same-chat grant keeps its membership, and a busy different chat cannot lose the tab', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const receipt = w.sessions.memberships.get(w.tab.id)!.id;
  const same = await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  assert.equal(same.membership, receipt);
  const other = await w.relay.connect('b');
  (w.sessions.chats.get('a') as any).status = 'running';
  await assert.rejects(other.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]), /still working/);
  assert.equal(w.sessions.owner.get(w.tab.id), 'a');
  (w.sessions.chats.get('a') as any).status = 'done';
  await other.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  assert.equal(w.sessions.owner.get(w.tab.id), 'b');
  assert.equal(w.tabs.list('a').length, 0);
  assert.equal(w.tabs.list('b')[0].wc.tabId, w.tab.id);
});

test('a grant cannot follow an intervening owner or survive a grouping refusal', async (t) => {
  const w = await setup(t);
  const offered = await w.sessions.admissions.offer(w.tab.id);
  const competing = await w.relay.connect('b');
  await competing.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  await assert.rejects(w.link.send('session.adopt', [offered]), /changed owners/);
  const other = w.chrome.addTab({ url: 'https://example.org/other' });
  w.chrome.fail['tabs.group'] = new Error('Chrome refused the move');
  await assert.rejects(w.link.send('session.adopt', [await w.sessions.admissions.offer(other.id)]), /could not move/);
  assert.equal(w.sessions.owner.has(other.id), false);
  assert.equal(w.relay.owns('a', other.id), false);
});

test('a pending native read cannot adopt after session close, and another grant can retry', async (t) => {
  const w = await setup(t);
  const offer = await w.sessions.admissions.offer(w.tab.id);
  const get = w.chrome.tabs.get;
  let finish: any;
  w.chrome.tabs.get = () =>
    new Promise((r) => {
      finish = r;
    });
  const pending = w.link.send('session.adopt', [offer]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  await w.sessions.close('a');
  finish(w.tab);
  await assert.rejects(pending, /changed owners/);
  assert.equal(w.sessions.owner.has(w.tab.id), false);
  w.chrome.tabs.get = get;
});

test('an idle owner that starts a turn while Chrome reads the tab keeps its tab', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const other = await w.relay.connect('b');
  const grant = await w.sessions.admissions.offer(w.tab.id);
  const get = w.chrome.tabs.get;
  let finish: any;
  w.chrome.tabs.get = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const moving = other.send('session.adopt', [grant]);
  await new Promise((resolve) => setImmediate(resolve));
  (w.sessions.chats.get('a') as any).status = 'running';
  finish(w.tab);
  await assert.rejects(moving, /still working/);
  assert.equal(w.sessions.owner.get(w.tab.id), 'a');
  w.chrome.tabs.get = get;
});

test('concurrent grants to the same chat coalesce to the acknowledged native membership', async (t) => {
  const w = await setup(t);
  const [one, two] = await Promise.all([w.sessions.admissions.offer(w.tab.id), w.sessions.admissions.offer(w.tab.id)]);
  const results = await Promise.allSettled([w.link.send('session.adopt', [one]), w.link.send('session.adopt', [two])]);
  assert.ok(results.every((r) => r.status === 'fulfilled'));
  assert.equal((results[0] as any).value.membership, (results[1] as any).value.membership);
});

test('a failed group move preserves the idle previous chat’s ownership', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const old = w.sessions.memberships.get(w.tab.id)!.id;
  const other = await w.relay.connect('b');
  const offer = await w.sessions.admissions.offer(w.tab.id);
  w.chrome.fail['tabs.group'] = new Error('Group move refused');
  await assert.rejects(other.send('session.adopt', [offer]), /could not move/);
  assert.equal(w.sessions.owner.get(w.tab.id), 'a');
  assert.equal(w.sessions.memberships.get(w.tab.id)!.id, old);
  assert.equal(w.ids('a')[0], w.tab.id);
});

test('a late group effect after its receiving chat closes is undone without closing the user’s tab', async (t) => {
  const w = await setup(t);
  const offer = await w.sessions.admissions.offer(w.tab.id);
  const group = w.chrome.tabs.group;
  let release: any;
  w.chrome.tabs.group = async (args: any) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return group(args);
  };
  const pending = w.link.send('session.adopt', [offer]);
  await new Promise((resolve) => setImmediate(resolve));
  await w.sessions.close('a');
  release();
  await assert.rejects(pending, /expired|changed/);
  assert.equal(w.chrome.tabsById.get(w.tab.id)?.groupId, -1);
  assert.ok(w.chrome.tabsById.has(w.tab.id));
});

test('a page that navigated after Send does not borrow the old page’s handoff grant', async (t) => {
  const w = await setup(t);
  const offer = await w.sessions.admissions.offer(w.tab.id);
  w.tab.url = 'https://different.example/';
  await assert.rejects(w.link.send('session.adopt', [offer]), /page changed/);
  assert.equal(w.sessions.owner.has(w.tab.id), false);
});

test('a retired transfer restores the previous chat even when Chrome deleted its now-empty group', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const oldReceipt = w.sessions.memberships.get(w.tab.id)!.id;
  const oldGroup = w.tab.groupId;
  const oldTitle = w.chrome.groups.get(oldGroup).title;
  const other = await w.relay.connect('b');
  const offered = await w.sessions.admissions.offer(w.tab.id);
  const group = w.chrome.tabs.group;
  let release: any,
    first = true;
  w.chrome.tabs.group = async (args: any) => {
    const previous = w.tab.groupId;
    const id = await group(args);
    if (![...w.chrome.tabsById.values()].some((tab: any) => tab.groupId === previous)) w.chrome.groups.delete(previous);
    w.sessions.onTabUpdated(w.tab.id, { groupId: id }, { ...w.tab });
    if (first) {
      first = false;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return id;
  };
  const pending = other.send('session.adopt', [offered]);
  await new Promise((resolve) => setImmediate(resolve));
  await w.sessions.close('b');
  release();
  await assert.rejects(pending, /expired|changed/);
  assert.equal(w.sessions.owner.get(w.tab.id), 'a');
  assert.equal(w.sessions.memberships.get(w.tab.id)!.id, oldReceipt);
  assert.equal(w.tab.groupId, w.sessions.chats.get('a')!.groupId);
  assert.notEqual(w.tab.groupId, oldGroup);
  assert.equal(w.chrome.groups.get(w.tab.groupId).title, oldTitle);
  assert.deepEqual(w.ids('a'), [w.tab.id]);
});

test('an idle owner that starts working during the native move regains the original tab and receipt', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const receipt = w.sessions.memberships.get(w.tab.id)!.id;
  const oldGroup = w.tab.groupId;
  const other = await w.relay.connect('b');
  const grant = await w.sessions.admissions.offer(w.tab.id);
  const group = w.chrome.tabs.group;
  let first = true;
  w.chrome.tabs.group = async (args: any) => {
    const id = await group(args);
    if (first) {
      first = false;
      (w.sessions.chats.get('a') as any).status = 'running';
    }
    return id;
  };
  await assert.rejects(other.send('session.adopt', [grant]), /expired|changed/);
  assert.equal(w.sessions.owner.get(w.tab.id), 'a');
  assert.equal(w.sessions.memberships.get(w.tab.id)!.id, receipt);
  assert.equal(w.tab.groupId, oldGroup);
});

test('rollback joins the previous owner’s replacement group rather than overwriting its newer allocation', async (t) => {
  const w = await setup(t);
  await w.link.send('session.adopt', [await w.sessions.admissions.offer(w.tab.id)]);
  const oldGroup = w.tab.groupId;
  const other = await w.relay.connect('b');
  const grant = await w.sessions.admissions.offer(w.tab.id);
  const group = w.chrome.tabs.group;
  let first = true;
  let newer: any;
  w.chrome.tabs.group = async (args: any) => {
    const id = await group(args);
    if (first) {
      first = false;
      w.chrome.groups.delete(oldGroup);
      newer = await w.link.send('chrome.tabs.create', [{ url: 'https://example.org/new' }]);
      await w.sessions.close('b');
    }
    return id;
  };
  await assert.rejects(other.send('session.adopt', [grant]), /expired|changed/);
  assert.equal(w.tab.groupId, newer.groupId);
  assert.equal(w.sessions.chats.get('a')!.groupId, newer.groupId);
  assert.equal(w.sessions.owner.get(w.tab.id), 'a');
});

test('a previously admitted ungroupable popup keeps its source proof when sent from its own panel', async (t) => {
  const w = await setup(t);
  const root = await w.link.send('chrome.tabs.create', [{}]);
  const popup = w.chrome.addTab({ openerTabId: root.id, url: 'https://example.org/popup' });
  w.chrome.fail['tabs.group'] = new Error('This popup window has no tab groups');
  await w.sessions.onTabCreated(popup);
  assert.equal(w.sessions.memberships.get(popup.id)!.manual, false);
  const acknowledged = await w.link.send('session.adopt', [await w.sessions.admissions.offer(popup.id)]);
  assert.equal(acknowledged.groupId, -1);
  assert.equal(w.sessions.memberships.get(popup.id)!.manual, false);
  assert.equal(w.relay.owns('a', popup.id, acknowledged.membership), true);
});
