// The real turn view puts Retry beside the latest terminal error, while history and read-only views keep only the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, user, turn, chat, view } from './support/thread-view/fixture.ts';

const failed = (id: string) =>
  turn(id, [user(`user-${id}`, 'retry my request')], {
    status: 'failed',
    error: { message: 'The provider could not finish the response.' },
  });

test('terminal failure keeps its reason and one Retry, and a newer turn retires the older action', async () => {
  chat([failed('old')]);
  const current = await render(view());
  assert.match(current.$('.turn-error')!.textContent!, /The provider could not finish the response/);
  const retries = () => current.$$('.turn-error button').filter((button) => button.textContent === 'Retry');
  assert.equal(retries().length, 1);
  await settle(() => chat([failed('old'), failed('new')]));
  assert.equal(retries().length, 1);
  assert.equal(
    [...current.$$('.turn-error')[0].querySelectorAll('button')].some((button) => button.textContent === 'Retry'),
    false,
  );
  await current.unmount();
});

test('read-only history retains the failure but never offers Retry', async () => {
  chat([failed('old')]);
  const history = await render(view({ readOnly: true }));
  assert.match(history.$('.turn-error')!.textContent!, /The provider could not finish the response/);
  assert.equal(history.$$('.turn-error button').filter((button) => button.textContent === 'Retry').length, 0);
  await history.unmount();
});
