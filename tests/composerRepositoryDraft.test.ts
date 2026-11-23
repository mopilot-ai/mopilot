// Repository composer drafts keep their text when a destination is missing or changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { all, fx, last, mountComposer, reset, settle, store } from './support/composer-setup.ts';

const env = { id: 'env', label: 'My env' };

test('a mixed project requires a location and refuses an environment from a retired account', async () => {
  const text = 'Keep this draft across a change of location';
  const cloud = { ...env, repo: 'org/app' };
  const repository = {
    key: 'repo:github.com/org/app',
    name: 'App',
    repository: 'github.com/org/app',
    destinations: [{ kind: 'cloud', ...env }],
  };
  reset();
  fx.caps.cloud = 'native';
  store.set({ drafts: { home: { text, attachments: [], goal: false } } });
  store.set({ newChatCloudEnv: null, newChatRepositoryGroup: { ...repository, needsLocation: true } });
  const m = await mountComposer();
  try {
    await m.key('Enter');
    await settle();
    assert.match(last('toast')?.[1] ?? '', /choose where to run/i);

    for (const cloudSidebar of [
      { account: 'retired-account', environments: [cloud] },
      { account: '[null,null]', environments: [{ id: 'other', label: 'Other' }] },
    ]) {
      store.set({ newChatCloudEnv: env, newChatRepositoryGroup: { ...repository, needsLocation: false }, cloudSidebar });
      await m.rerender();
      await m.key('Enter');
      await settle();
      assert.match(last('toast')?.[1] ?? '', /choose a cloud environment for this project/i);
      assert.equal(all('cloudExec').length, 0);
      assert.equal(all('send').length, 0);
      assert.equal(m.text, text);
    }

    store.set({ accounts: { active: 'current-account' }, cloudSidebar: { account: '["current-account",null]', environments: [cloud] } });
    await m.rerender();
    await m.key('Enter');
    await settle();
    assert.deepEqual(last('cloudExec')?.slice(1), [env.id, text, 1, { repository: 'github.com/org/app', account: 'current-account' }]);
    assert.equal(m.text, '');
  } finally {
    await m.unmount();
  }
});
