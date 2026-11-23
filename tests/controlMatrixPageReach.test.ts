// Control matrix: what the page agent reaches on every browser route (#3571, G9). The page agent and the browser host
// tab are shared by the in-app browser, the user's Chrome over MoPilot's extension and a Host's Chromium, on every
// harness, so each case holds for IAB and BU on Claude Code, Codex, a switched chat and ACP alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { win, agent, load, refAt } from './support/page-agent/fixture.ts';
import { supportDefined } from './support/page-agent/defined.ts';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const { PAGE_AGENT_SOURCE } = createRequire(import.meta.url)('../electron/capabilities/browser/pageAgent.cjs');

test('CM-K43: a control inside a closed shadow root is read and hit-tested once main hands the root over', async (t) => {
  // the page agent's half: flagged, offered, adopted, then listed
  supportDefined(win);
  if (!win.customElements.get('x-widget')) win.customElements.define('x-widget', class extends win.HTMLElement {});
  const $ = load('<x-widget id=w></x-widget>');
  const root = $('w').attachShadow({ mode: 'closed' });
  root.innerHTML = '<button>Closed shadow button</button>';
  assert.equal(agent.call('tree', { filter: 'interactive' }).closedRoots, true);
  assert.deepEqual(agent.closedHosts(), [$('w')]);
  assert.equal(agent.adopt($('w'), root), true);
  assert.match(agent.call('tree', { filter: 'interactive' }).value.lines.join('\n'), /button "Closed shadow button" \[ref_\d+\]/);
  // main's half, through the tab every route shares: the read runs again after the hand-over
  const tab = tabOf(setup(t));
  let reads = 0;
  tab.wc.handlers['Runtime.evaluate'] = (p: any) => {
    if (p.expression === `${PAGE_AGENT_SOURCE}, true`) return { result: { value: true } };
    if (p.expression.startsWith('globalThis.__mopilotAgent.closedHosts(')) return { result: { objectId: 'arr' } };
    reads++;
    return { result: { value: { value: reads === 1 ? 'without' : 'with', seq: 1, ...(reads === 1 ? { closedRoots: true } : {}) } } };
  };
  tab.wc.handlers['Runtime.getProperties'] = () => ({ result: [{ name: '0', value: { objectId: 'host' } }] });
  tab.wc.handlers['DOM.describeNode'] = () => ({ node: { shadowRoots: [{ shadowRootType: 'closed', backendNodeId: 9 }] } });
  tab.wc.handlers['DOM.resolveNode'] = () => ({ object: { objectId: 'root' } });
  tab.wc.handlers['Runtime.callFunctionOn'] = () => ({ result: { value: true } });
  assert.equal(await drive(t, tab.agent('tree', { filter: 'interactive' })), 'with');
});

test('CM-K44: a ref whose control re-rendered with the same tag, role and name acts on the new element', () => {
  const $ = load('<div id=row><button>Save</button></div>');
  const save = refAt(agent.call('tree', { filter: 'interactive' }).value.lines, 'button "Save"');
  $('row').innerHTML = '<button id=fresh>Save</button>';
  assert.equal(agent.element(save), $('fresh'));
});

test('CM-K45: a ref never moves to a different control or to one of two twins: the step is refused as stale', () => {
  const $ = load('<div id=a><button>Submit</button></div><div id=b><button>Next</button></div>');
  const lines = agent.call('tree', { filter: 'interactive' }).value.lines;
  const submit = refAt(lines, 'button "Submit"');
  const next = refAt(lines, 'button "Next"');
  $('a').innerHTML = '<button>Delete account</button>';
  $('b').innerHTML = '<button>Next</button><button>Next</button>';
  assert.deepEqual(agent.call('locate', { ref: submit }).value, { error: 'stale', ref: submit });
  assert.deepEqual(agent.call('locate', { ref: next }).value, { error: 'stale', ref: next });
});
