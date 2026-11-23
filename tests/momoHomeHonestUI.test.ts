// MoMo's home surfaces never claim what the home did not confirm, and stay usable under pressure (src/components/momo/home): a refused move shows the home's cause and fix and changes nothing, a move in flight locks its card, a double press is one move, the composer keeps its text until the message is accepted, a card expires on screen, dialogs take focus and give it back, keys work in the setup radio group, a unknown row or step does not break the page, and a change to one part redraws only that part.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  createElement,
  createFixtureSeam,
  createRoot,
  fixtureView,
  flush,
  mount,
  MomoHomePage,
  nav,
  NOW,
  resetMomoHomeStore,
  scenarioView,
  setMomoHomeSeam,
  window,
} from './support/momoHomeRig.ts';

const body = () => window.document.body as any;
const press = async (label: string | RegExp) => {
  const b = [...body().querySelectorAll('button')].find((x: any) =>
    typeof label === 'string' ? x.textContent.trim() === label : label.test(x.textContent.trim()),
  ) as any;
  assert.ok(b, `no button ${label}`);
  await act(async () => b.click());
  await flush();
};
const key = async (el: any, k: string, extra: Record<string, unknown> = {}) => {
  await act(async () => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })));
  await flush();
};

/** A seam whose moves wait until the test lets them go, and which records what was asked. */
function gated(v = scenarioView(null)) {
  const seam = createFixtureSeam(v, () => NOW);
  const real = seam.act;
  const calls: any[] = [];
  const gates: ((r: any) => void)[] = [];
  seam.act = (a: any) => {
    calls.push(a);
    return new Promise((res) => gates.push((r) => res(r ?? real(a))));
  };
  return { seam, calls, release: async (r?: any) => act(async () => void gates.shift()?.(r)) };
}

async function mountSeam(seam: any, tab: any = 'chat', props: Record<string, unknown> = {}) {
  setMomoHomeSeam(seam);
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  body().appendChild(host);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, { tab, ...props })));
  await flush();
  return {
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      body().innerHTML = '';
    },
  };
}

test('Send waits for the home: the card says it is working and locked, then shows what the home answered', async () => {
  const g = gated();
  const m = await mountSeam(g.seam, 'chat', { now: NOW });
  await press('Send');
  assert.equal(g.calls.length, 1);
  const card = body().querySelector('[data-testid="momo-card-card-1"]');
  assert.equal(card.getAttribute('data-status'), 'pending', 'nothing claims success yet');
  assert.ok(card.textContent.includes('Working…'));
  assert.equal(card.getAttribute('aria-busy'), 'true');
  for (const label of ['Send', 'Edit', 'Don’t send'])
    assert.equal([...card.querySelectorAll('button')].find((b: any) => b.textContent === label).disabled, true, label);
  // a second press while it goes is the same press
  await act(async () => [...card.querySelectorAll('button')].find((b: any) => b.textContent === 'Send').click());
  assert.equal(g.calls.length, 1);
  await g.release();
  await flush();
  assert.equal(body().querySelector('[data-testid="momo-card-card-1"]').getAttribute('data-status'), 'completed');
  await m.close();
});

test('a refused Send changes nothing and says the home’s cause with its fix; the fix is sent as the intent the home named', async () => {
  const g = gated();
  const m = await mountSeam(g.seam, 'chat', { now: NOW });
  await press('Send');
  await g.release({
    ok: false,
    cause: 'Gmail needs you to sign in again.',
    fix: { label: 'Reconnect Gmail', intent: { kind: 'fix', id: 'sign-in-gmail' } },
  });
  await flush();
  const card = body().querySelector('[data-testid="momo-card-card-1"]');
  assert.equal(card.getAttribute('data-status'), 'pending');
  assert.ok(card.textContent.includes('Gmail needs you to sign in again.'));
  assert.equal([...card.querySelectorAll('button')].find((b: any) => b.textContent === 'Send').disabled, false);
  await press('Reconnect Gmail');
  assert.deepEqual(g.calls.at(-1), { type: 'intent', intent: { kind: 'fix', id: 'sign-in-gmail' } });
  await g.release({ ok: true });
  await m.close();
});

test('an Edit during a Send is not possible, and the edit text is kept when the home refuses it', async () => {
  const g = gated();
  const m = await mountSeam(g.seam, 'chat', { now: NOW });
  await press('Edit');
  const area = body().querySelector('textarea[aria-label="Message"]');
  assert.equal(window.document.activeElement, area, 'focus moves into the field that opened');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'My version.');
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await press('Save');
  assert.equal(body().querySelector('textarea[aria-label="Message"]').readOnly, true, 'the field is read-only, not dropped, while it goes');
  assert.equal(
    [...body().querySelectorAll('button')].find((b: any) => b.textContent === 'Cancel' && b.closest('[data-testid]')).disabled,
    true,
  );
  await g.release({ ok: false, cause: 'The card was answered on your iPhone.' });
  await flush();
  assert.equal(body().querySelector('textarea[aria-label="Message"]').value, 'My version.');
  assert.ok(body().textContent.includes('The card was answered on your iPhone.'));
  await m.close();
});

test('the composer keeps its text until the home accepts the message, and a double Enter is one message', async () => {
  const g = gated();
  const m = await mountSeam(g.seam);
  const input = () => body().querySelector('input[aria-label="Message MoMo"]');
  const type = async (v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), v);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const submit = async () =>
    act(
      async () =>
        void body()
          .querySelector('form')
          .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
  await type('Call Dana');
  await submit();
  await submit();
  assert.equal(g.calls.filter((c) => c.type === 'chat.send').length, 1);
  assert.equal(input().value, 'Call Dana', 'still there while it goes');
  const turn = g.calls[0].turnId;
  await g.release({ ok: false, cause: 'Studio is offline.' });
  await flush();
  assert.equal(input().value, 'Call Dana', 'put back when refused');
  assert.ok(body().textContent.includes('Studio is offline.'));
  await submit();
  assert.equal(g.calls.at(-1).turnId, turn, 'a retry is the same turn, so the home can tell it is one message');
  await g.release({ ok: true });
  await flush();
  assert.equal(input().value, '');
  await type('Next');
  await submit();
  assert.notEqual(g.calls.at(-1).turnId, turn);
  await g.release({ ok: true });
  await m.close();
});

test('Start on a brief offer is one message however fast it is pressed', async () => {
  const g = gated();
  const m = await mountSeam(g.seam);
  await act(async () => {
    const b = [...body().querySelectorAll('button')].find((x: any) => x.textContent === 'Start');
    b.click();
    b.click();
  });
  assert.equal(g.calls.filter((c) => c.type === 'brief.start').length, 1);
  await g.release();
  await m.close();
});

test('a card that expires does so on screen, and answering an expired card shows the home’s refusal', async () => {
  const v = fixtureView();
  const row: any = v.chat.find((r) => r.kind === 'approval');
  row.approval.expiresAt = Date.now() + 120;
  const seam = createFixtureSeam(v);
  const m = await mountSeam(seam);
  assert.equal(body().querySelector('[data-testid="momo-card-card-1"]').getAttribute('data-status'), 'pending');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
  await flush();
  const card = body().querySelector('[data-testid="momo-card-card-1"]');
  assert.equal(card.getAttribute('data-status'), 'expired');
  assert.ok(card.textContent.includes('Nobody answered in 30 minutes. Nothing was done.'));
  await m.close();
  const past = fixtureView();
  (past.chat.find((r) => r.kind === 'approval') as any).approval.expiresAt = Date.now() - 1;
  const m2 = await mountSeam(createFixtureSeam(past));
  assert.equal(body().querySelector('[data-testid="momo-card-card-1"]').getAttribute('data-status'), 'expired');
  await m2.close();
});

test('the Stop question takes focus on Cancel, keeps Tab inside, closes on Escape and gives focus back', async () => {
  const m = await mount(null, 'tasks');
  await m.click(/^Build the Acme quote sheet/);
  const stop = [...body().querySelectorAll('button')].find((b: any) => b.textContent === 'Stop');
  stop.focus();
  await act(async () => stop.click());
  await flush();
  const dialog = body().querySelector('[role="alertdialog"]');
  const [ok, cancel] = [...dialog.querySelectorAll('button')];
  assert.equal(window.document.activeElement, cancel);
  await key(cancel, 'Tab');
  assert.equal(window.document.activeElement, ok, 'Tab from the last control goes to the first');
  await key(ok, 'Tab', { shiftKey: true });
  assert.equal(window.document.activeElement, cancel, 'Shift+Tab from the first goes to the last');
  await key(cancel, 'Escape', { isComposing: true });
  assert.ok(body().querySelector('[role="alertdialog"]'), 'Escape inside an input method composition is not for the dialog');
  await key(cancel, 'Escape');
  assert.equal(body().querySelector('[role="alertdialog"]'), null);
  assert.equal(window.document.activeElement?.textContent, 'Stop', 'focus is back where it was');
  await m.close();
});

test('the Where-MoMo-runs sheet takes focus and Escape closes it', async () => {
  const m = await mount(null);
  await m.click('Runs on Studio');
  const sheet = body().querySelector('[role="dialog"]');
  assert.ok(sheet.contains(window.document.activeElement));
  await key(sheet, 'Escape');
  assert.equal(body().querySelector('[role="dialog"]'), null);
  await m.close();
});

test('the setup radio group moves with the arrow keys, skips machines that cannot be picked and keeps one tab stop', async () => {
  const m = await mount('first-run');
  const radios = () => [...body().querySelectorAll('[role="radio"]')] as any[];
  assert.deepEqual(
    radios().map((r) => r.getAttribute('aria-checked')),
    ['true', 'false', 'false', 'false'],
  );
  assert.deepEqual(
    radios().map((r) => r.getAttribute('tabindex')),
    ['0', '-1', '-1', '-1'],
  );
  assert.equal(radios()[0].getAttribute('aria-current'), null);
  await key(radios()[0], 'ArrowDown');
  assert.deepEqual(
    radios().map((r) => r.getAttribute('aria-checked')),
    ['false', 'true', 'false', 'false'],
  );
  await key(radios()[1], 'ArrowRight');
  assert.equal(radios()[0].getAttribute('aria-checked'), 'true', 'it wraps past the machines that are not online');
  await key(radios()[0], 'ArrowUp');
  assert.equal(radios()[1].getAttribute('aria-checked'), 'true');
  await key(radios()[1], 'ArrowLeft');
  assert.equal(radios()[0].getAttribute('aria-checked'), 'true');
  await key(radios()[0], 'a');
  await act(async () => radios()[2].click());
  assert.equal(radios()[0].getAttribute('aria-checked'), 'true', 'a machine that is not online is not picked');
  await key(radios()[2], 'ArrowDown');
  assert.equal(radios()[0].getAttribute('aria-checked'), 'true');
  await m.close();
});

test('a row kind or a setup step this version does not know does not break the page', async () => {
  const v = scenarioView(null);
  v.chat = [{ kind: 'from-the-future', id: 'x1' } as any, ...v.chat.slice(1, 2)];
  const m = await mountSeam(createFixtureSeam(v));
  assert.ok(body().textContent.includes('MoMo shows something here that this version of MoPilot can’t draw.'));
  assert.ok(body().textContent.includes('Dana Lee just replied'));
  await m.close();
  const odd = scenarioView(null);
  odd.setup.step = 'verify-your-phone' as any;
  const m2 = await mountSeam(createFixtureSeam(odd));
  assert.ok(body().querySelector('[data-momo-home]'), 'the page, not a dead end');
  await m2.close();
});

test('the brief’s settings send a picked time at once and a typed number after a pause, and show the home’s value', async () => {
  const g = gated();
  const m = await mountSeam(g.seam, 'rules');
  const time = body().querySelectorAll('input[type="time"]')[0];
  const set = async (el: any, v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, v);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await set(time, '07:30');
  assert.deepEqual(g.calls.at(-1), { type: 'settings.set', patch: { briefTime: '07:30' } });
  await g.release();
  await flush();
  const cap = body().querySelector('input[type="number"]');
  await set(cap, '3');
  await set(cap, '4');
  assert.equal(g.calls.filter((c) => c.patch?.dailyCap).length, 0, 'not while it is still being typed');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });
  assert.deepEqual(g.calls.at(-1), { type: 'settings.set', patch: { dailyCap: 4 } });
  await g.release();
  await set(cap, 'x');
  await act(async () => cap.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
  await set(time, '');
  await act(async () => time.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
  assert.equal(g.calls.length, 2, 'an empty or non-number value is not sent');
  await m.close();
});

test('a keystroke in the composer redraws no row, and a change to one task redraws only that task', async () => {
  const seen: Record<string, number> = {};
  (globalThis as any).__momoRenderProbe = (n: string) => (seen[n] = (seen[n] ?? 0) + 1);
  const seam = createFixtureSeam(scenarioView(null), () => NOW);
  const m = await mountSeam(seam);
  const before = { ...seen };
  const input = body().querySelector('input[aria-label="Message MoMo"]');
  for (const v of ['a', 'ab', 'abc']) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  assert.deepEqual(seen, before, 'no chat row redrew for three keystrokes');
  await m.close();
  for (const k of Object.keys(seen)) delete seen[k];
  const t = await mountSeam(seam, 'tasks');
  const first = { ...seen };
  assert.ok(Object.keys(first).some((k) => k.startsWith('task:')));
  await act(async () =>
    seam.script((v) => ({ ...v, tasks: v.tasks.map((x) => (x.id === 't-quote' ? { ...x, step: 'Almost done' } : x)) })),
  );
  await flush();
  const changed = Object.keys(seen).filter((k) => seen[k] !== first[k]);
  assert.deepEqual(changed, ['task:t-quote']);
  assert.ok(body().textContent.includes('Almost done'));
  await t.close();
  delete (globalThis as any).__momoRenderProbe;
  assert.deepEqual(nav.length >= 0, true);
});
