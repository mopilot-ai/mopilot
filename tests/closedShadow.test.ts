// Closed shadow roots, main's half (#3571, G9; electron/capabilities/browser/closedShadow.cjs): the hosts the page agent
// offers are described with pierce, a closed root is resolved in the agent's world and handed over, a read op runs once
// more, and a tab's agent() and agentAt() go through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const {
  adoptClosedRoots,
  readThroughClosedRoots,
  RESCAN_OPS,
  HOSTS_PER_READ,
} = require('../electron/capabilities/browser/closedShadow.cjs');
const { PAGE_AGENT_SOURCE } = require('../electron/capabilities/browser/pageAgent.cjs');

/** A CDP fake: `hosts` maps a host object id to its shadow roots; `adopt` answers the hand-over. */
function fakeTab({
  hosts = {} as Record<string, any[]>,
  list = { result: { objectId: 'arr' } } as any,
  adopt = (_: any) => true as any,
  fail = new Set<string>(),
} = {}) {
  const sent: { method: string; params: any; sessionId?: string }[] = [];
  const tab = {
    sent,
    async send(method: string, params: any, sessionId?: string) {
      sent.push({ method, params, sessionId });
      if (fail.has(method)) throw new Error(`${method} failed`);
      switch (method) {
        case 'Runtime.evaluate':
          return list;
        case 'Runtime.getProperties':
          return {
            result: [
              ...Object.keys(hosts).map((id, i) => ({ name: String(i), value: { objectId: id } })),
              { name: 'length', value: { value: Object.keys(hosts).length } },
              { name: String(Object.keys(hosts).length), value: {} },
            ],
          };
        case 'DOM.describeNode':
          return { node: hosts[params.objectId] === undefined ? undefined : { shadowRoots: hosts[params.objectId] } };
        case 'DOM.resolveNode':
          return { object: { objectId: `root-${params.backendNodeId}` } };
        case 'Runtime.callFunctionOn':
          return { result: { value: adopt(params) } };
        default:
          return {};
      }
    },
  };
  return tab;
}

test('adoptClosedRoots: each offered host with a closed root gets it, in the agent world, and the group is let go', async () => {
  const tab = fakeTab({
    hosts: {
      h1: [{ shadowRootType: 'closed', backendNodeId: 11 }],
      h2: [{ shadowRootType: 'open', backendNodeId: 12 }],
      h3: [],
      h4: undefined as any,
    },
  });
  assert.equal(await adoptClosedRoots(tab, 7, 'S1'), true);
  const of = (m: string) => tab.sent.filter((c) => c.method === m);
  assert.equal(of('Runtime.evaluate')[0].params.expression, `globalThis.__mopilotAgent.closedHosts(${HOSTS_PER_READ})`);
  assert.equal(of('Runtime.evaluate')[0].params.contextId, 7);
  assert.deepEqual(
    of('DOM.describeNode').map((c) => c.params),
    ['h1', 'h2', 'h3', 'h4'].map((objectId) => ({ objectId, depth: 1, pierce: true })),
  );
  assert.deepEqual(
    of('DOM.resolveNode').map((c) => c.params),
    [{ backendNodeId: 11, executionContextId: 7, objectGroup: 'mopilot-closed-shadow' }],
  );
  assert.deepEqual(of('Runtime.callFunctionOn')[0].params.arguments, [{ objectId: 'root-11' }]);
  assert.equal(of('Runtime.callFunctionOn')[0].params.objectId, 'h1');
  assert.deepEqual(
    of('Runtime.releaseObjectGroup').map((c) => [c.params.objectGroup, c.sessionId]),
    [['mopilot-closed-shadow', 'S1']],
  );
  assert.ok(tab.sent.every((c) => c.sessionId === 'S1'));
});

test('adoptClosedRoots: nothing offered, a refused hand-over, a host that left and a release that fails all end false or quietly', async () => {
  assert.equal(await adoptClosedRoots(fakeTab({ list: { result: {} } }), 1, ''), false);
  assert.equal(await adoptClosedRoots(fakeTab({ list: undefined }), 1, ''), false);
  const closed = { h: [{ shadowRootType: 'closed', backendNodeId: 1 }] };
  assert.equal(await adoptClosedRoots(fakeTab({ hosts: closed, adopt: () => false }), 1, ''), false);
  assert.equal(await adoptClosedRoots(fakeTab({ hosts: closed, fail: new Set(['DOM.resolveNode']) }), 1, ''), false);
  const noProps = fakeTab({ hosts: closed });
  const send = noProps.send.bind(noProps);
  noProps.send = async (m: string, p: any, s?: string) => (m === 'Runtime.getProperties' ? undefined : send(m, p, s));
  assert.equal(await adoptClosedRoots(noProps, 1, ''), false);
  // a page that went away while letting go of the group
  assert.equal(await adoptClosedRoots(fakeTab({ hosts: closed, fail: new Set(['Runtime.releaseObjectGroup']) }), 1, ''), true);
  // a failure before anything was handed over still lets go, then reports
  const broken = fakeTab({ fail: new Set(['Runtime.getProperties']) });
  await assert.rejects(adoptClosedRoots(broken, 1, ''), /getProperties failed/);
  assert.equal(broken.sent.at(-1)!.method, 'Runtime.releaseObjectGroup');
});

test('readThroughClosedRoots: a read flagged by the agent runs once more after a hand-over; writes and unflagged reads run once', async () => {
  const closed = { h: [{ shadowRootType: 'closed', backendNodeId: 1 }] };
  const runs: boolean[] = [];
  const reply = (closedRoots: boolean) => async (again: boolean) => (
    runs.push(again), { result: { value: { value: again ? 'second' : 'first', closedRoots } } }
  );
  const value = (r: any) => r.result.value.value;
  assert.equal(value(await readThroughClosedRoots(fakeTab({ hosts: closed }), 'tree', 1, '', reply(true))), 'second');
  assert.deepEqual(runs.splice(0), [false, true]);
  assert.equal(value(await readThroughClosedRoots(fakeTab({ hosts: closed }), 'tree', 1, '', reply(false))), 'first');
  assert.equal(
    value(await readThroughClosedRoots(fakeTab({ hosts: closed }), 'formInput', 1, '', reply(true))),
    'first',
    'a write never runs twice',
  );
  assert.equal(value(await readThroughClosedRoots(fakeTab({ hosts: {} }), 'find', 1, '', reply(true))), 'first', 'nothing handed over');
  // a hand-over that fails leaves the read that worked standing
  const broken = fakeTab({ hosts: closed, fail: new Set(['Runtime.getProperties']) });
  assert.equal(value(await readThroughClosedRoots(broken, 'tree', 1, '', reply(true))), 'first');
  assert.equal(await readThroughClosedRoots(fakeTab(), 'tree', 1, '', async () => undefined), undefined);
  assert.ok(!RESCAN_OPS.has('formInput') && !RESCAN_OPS.has('scrollTo') && !RESCAN_OPS.has('select') && !RESCAN_OPS.has('focus'));
});

/** The tab's agent call fake: the first read flags closed roots, the hand-over succeeds, the second read is clean. */
function wireClosedRoots(tab: any) {
  const reads: string[] = [];
  tab.wc.handlers['Runtime.evaluate'] = (p: any) => {
    if (p.expression === `${PAGE_AGENT_SOURCE}, true`) return { result: { value: true } };
    if (p.expression.startsWith('globalThis.__mopilotAgent.closedHosts(')) return { result: { objectId: 'arr' } };
    reads.push(p.expression.startsWith(PAGE_AGENT_SOURCE) ? 'inproc' : 'session');
    return { result: { value: { value: reads.length, seq: 1, ...(reads.length % 2 ? { closedRoots: true } : {}) } } };
  };
  tab.wc.handlers['Runtime.getProperties'] = () => ({ result: [{ name: '0', value: { objectId: 'host' } }] });
  tab.wc.handlers['DOM.describeNode'] = () => ({ node: { shadowRoots: [{ shadowRootType: 'closed', backendNodeId: 5 }] } });
  tab.wc.handlers['DOM.resolveNode'] = () => ({ object: { objectId: 'root' } });
  tab.wc.handlers['Runtime.callFunctionOn'] = () => ({ result: { value: true } });
  return reads;
}

test('tab.agent and tab.agentAt read again after handing closed roots over, and dispatch is reported once', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const reads = wireClosedRoots(tab);
  let dispatched = 0;
  assert.equal(
    await drive(
      t,
      tab.agent('tree', {}, '', () => dispatched++),
    ),
    2,
  );
  assert.deepEqual(reads.splice(0), ['session', 'session']);
  assert.ok(dispatched <= 1, 'the second read reports no second dispatch');
  assert.equal(tab.wc.debugger.sent('Runtime.callFunctionOn').length, 1);
  // a frame in the session's process
  assert.equal(await drive(t, tab.agentAt({ sessionId: '', frameId: 'child' }, 'find', { query: 'x' })), 2);
  assert.deepEqual(reads.splice(0), ['inproc', 'inproc']);
});

test('tab.agent in a cross-origin frame (readPage expanding a FRAME marker) hands that frame its closed roots, in the frame session', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const reads = wireClosedRoots(tab);
  tab.frames.set('F1', { parent: '' });
  assert.equal(await drive(t, tab.agent('tree', {}, 'F1')), 2);
  assert.deepEqual(reads.splice(0), ['session', 'session']);
  const handed = tab.wc.debugger.sent('Runtime.callFunctionOn');
  assert.equal(handed.length, 1);
  assert.equal(handed[0].sessionId, 'F1');
});
