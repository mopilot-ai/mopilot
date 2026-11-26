// A press shows itself at once, and a failure said about a card goes when the cards change: the button reads Working… until the home answers, then the next state replaces the card; a "can't do that yet" does not stay across a new state of the home.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, find, flush, homeIs, mount, tap, unmountAll, type Any } from './support/phone/momo-screens';

afterEach(unmountAll);

test('a pressed Wake already says Waking Studio…, and stays off until the home answers', async () => {
  const m = await mount(homeIs('asleep'));
  m.transport.send = async () => new Promise(() => undefined);
  await tap('Wake');
  assert.equal(find('Waking Studio…')?.getAttribute('aria-disabled'), 'true');
  assert.equal(m.text().includes('Working…'), false, 'a title that says so already is not replaced');
});

test('a pressed button reads Working… and is off until the home has answered, then the card is replaced', async () => {
  const m = await mount(homeIs('needs-update'));
  let answer: (r: Any) => void = () => undefined;
  m.transport.send = async () => new Promise((resolve) => (answer = resolve));
  await tap('Update');
  assert.match(m.text(), /Working…/);
  const pressed = find('Update Studio');
  assert.equal(pressed?.textContent, 'Working…', 'VoiceOver still hears what the button does (its label), the eye reads the state');
  assert.equal(pressed?.getAttribute('aria-disabled'), 'true');
  await act(async () => answer({ ok: true, view: { view: { ...m.view.view, home: { ...m.view.view.home, state: 'running' } } } }));
  await flush();
  assert.equal(m.text().includes('Working…'), false);
  assert.equal(m.text().includes('out of date'), false, 'the card is replaced by the next state');
});

test('a refusal stays until the cards change, then it goes', async () => {
  const m = await mount(homeIs('asleep'));
  m.transport.fail({ ok: false, cause: 'MoMo can’t do that yet.' });
  await tap('Wake');
  assert.match(m.text(), /MoMo can’t do that yet\./);
  // a push that changes nothing about the home leaves it
  await act(async () => m.transport.emit({ now: m.view.now + 1 }));
  assert.match(m.text(), /MoMo can’t do that yet\./);
  // the home woke: what the refusal was about is gone
  await act(async () => m.transport.emit({ view: { ...m.view.view, home: { ...m.view.view.home, state: 'running' } } }));
  await flush();
  assert.equal(m.text().includes('MoMo can’t do that yet.'), false);
});

test('a refusal about a move goes when the move goes on to its next step', async () => {
  const move = (step: string) => ({
    moveId: 'm1',
    from: { machineId: 'studio', name: 'Studio' },
    to: { machineId: 'mini', name: 'Mac mini' },
    step,
    outcome: 'running',
    finishedAt: null,
    failure: null,
    oldMachineOffline: false,
    reclaim: null,
  });
  const m = await mount((v) => Object.assign(v.home, { state: 'moving', move: move('sealed') }));
  m.transport.fail({ ok: false, cause: 'Mac mini is not answering.' });
  await tap('Cancel');
  assert.match(m.text(), /Mac mini is not answering\./);
  await act(async () => m.transport.emit({ view: { ...m.view.view, home: { ...m.view.view.home, move: move('copied') } } }));
  await flush();
  assert.equal(m.text().includes('Mac mini is not answering.'), false);
});
