// The question before MoPilot adds its key to a machine: what is asked, and that only an explicit "add" is a yes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const { keyConsent } = createRequire(import.meta.url)('../electron/host/keyConsent.cjs');

test('the question names the machine, the key file and where it is added; only "add" lets the key be made', async () => {
  const asked: any[] = [];
  const answers: (string | null)[] = ['add', 'yes', '', null];
  const consent = keyConsent(async (q: any) => (asked.push(q), answers.shift() ?? null));
  assert.equal(await consent('me@box', '~/.ssh/mopilot_ed25519'), true);
  assert.deepEqual(asked[0], {
    destination: 'me@box',
    kind: 'keyConsent',
    host: 'box',
    publicKeyFile: '~/.ssh/mopilot_ed25519.pub',
    addsTo: '~/.ssh/authorized_keys',
    store: 'file',
    choices: ['add'],
    text: 'MoPilot reconnects in the background, so it adds its own key (~/.ssh/mopilot_ed25519) to box.',
  });
  for (const _ of ['yes', '', null]) assert.equal(await consent('me@box', '~/.ssh/mopilot_ed25519'), false);
});
