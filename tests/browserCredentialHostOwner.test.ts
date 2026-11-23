// Host ownership retires pending saved-login requests before a store read, field discovery or credential dispatch can continue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor';
import { makeTab, makeTabs, LOGIN } from './support/browserCredentialTabs';
const require = createRequire(import.meta.url);
const { CredentialHandoff, requestCredentials } = require('../electron/capabilities/browser/credentials.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');
const USER = 'synthetic@example.test';
const SECRET = 'synthetic-test-secret';
const ctx = () => ({ chatId: 'c1', segmentId: 's1', signal: null });
async function opened(handoff: any, run: () => Promise<any>) {
  const p = run();
  await waitFor(() => handoff.list().length, 'the sheet to open');
  return { p, sheet: handoff.list()[0] };
}
test('#4256: moving to another Host while the saved-login sheet waits refuses before saved values or page input', async () => {
  const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
  const tabs = makeTabs(tab);
  let local = true;
  let gets = 0;
  const handoff = new CredentialHandoff({
    store: {
      available: () => true,
      list: () => [],
      get: () => {
        gets++;
        return { username: USER, password: SECRET };
      },
    },
  });
  const { p, sheet } = await opened(handoff, () =>
    requestCredentials(
      {
        tabs,
        handoff,
        checkOwner: () => {
          if (!local) throw new ToolError('Owner moved', 'unavailable');
        },
      },
      tab,
      {},
      ctx(),
    ),
  );
  local = false;
  handoff.answer(sheet.id, { action: 'fill', savedId: 'saved' });
  await assert.rejects(p, (e: any) => e.code === 'unavailable');
  assert.equal(gets, 0);
  assert.deepEqual(tab.typed, {});
});

test('#4256: moving while credential fields are detected refuses before the saved-login sheet is opened', async () => {
  const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
  const tabs = makeTabs(tab);
  let local = true;
  const agent = tab.agent.bind(tab);
  tab.agent = async (...args: any[]) => {
    const result = await agent(...args);
    local = false;
    return result;
  };
  const handoff = new CredentialHandoff();
  await assert.rejects(
    requestCredentials(
      {
        tabs,
        handoff,
        checkOwner: () => {
          if (!local) throw new ToolError('Owner moved', 'unavailable');
        },
      },
      tab,
      {},
      ctx(),
    ),
    (e: any) => e.code === 'unavailable',
  );
  assert.deepEqual(handoff.list(), []);
});
