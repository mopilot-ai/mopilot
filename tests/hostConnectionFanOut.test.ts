// A Host connection tells its listeners one at a time (electron/host/fanOut.cjs): one that throws is reported and does not keep the ones after it from hearing, and a refused tool-relay request is a rejected promise, never a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fanOut } = require('../electron/host/fanOut.cjs');
const { createChannels } = require('../electron/host/remoteChannels.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

test('every listener hears the event, in order, even after one threw; the throw is reported with what the event was', () => {
  clearIgnored();
  const heard: string[] = [];
  fanOut(
    new Set([
      (n: number) => heard.push(`a${n}`),
      () => {
        throw new Error('boom');
      },
      (n: number) => heard.push(`c${n}`),
    ]),
    7,
    'a state change',
  );
  assert.deepEqual(heard, ['a7', 'c7']);
  const [report] = recentIgnored();
  assert.match(report.context, /a state change/);
  assert.match(report.message, /boom/);
});

test('a listener that removes itself while the event is told does not skip the next one', () => {
  const heard: string[] = [];
  const set = new Set<(n: number) => void>();
  const first = () => (heard.push('first'), set.delete(first));
  set.add(first);
  set.add(() => heard.push('second'));
  fanOut(set, 1, 'x');
  assert.deepEqual(heard, ['first', 'second']);
});

test('the tool relay request of a Host that refuses it is a rejected promise, not a throw, so a caller can filter it', async () => {
  const refusal = Object.assign(new Error('The host cannot do this safely yet (it lacks tools).'), { missing: ['tools'] });
  const channels = createChannels({
    needs: () => {
      throw refusal;
    },
    request: async () => assert.fail('nothing is sent'),
    epochOf: () => 0,
    live: () => undefined,
  });
  let returned: unknown;
  assert.doesNotThrow(() => {
    returned = channels.tools.request('host.toolsSync', { tools: [] });
  });
  await assert.rejects(returned as Promise<unknown>, (e: any) => e === refusal);
});

test('a tool call or browser event reaches every listener of its channel even when one throws', () => {
  const channels = createChannels({ needs: () => undefined, request: async () => ({}), epochOf: () => 0, live: () => undefined });
  const heard: string[] = [];
  channels.tools.onEvent(() => {
    throw new Error('relay broke');
  });
  channels.tools.onEvent((e: any) => heard.push(`tool:${e.event}`));
  channels.browser.onEvent(() => {
    throw new Error('pane broke');
  });
  channels.browser.onEvent((e: any) => heard.push(`browser:${e.chatId}`));
  assert.equal(channels.route({ event: 'tool', callId: 'k' }), true);
  assert.equal(channels.route({ event: 'browser', chatId: 'c1', payload: {} }), true);
  assert.deepEqual(heard, ['tool:tool', 'browser:c1']);
});
