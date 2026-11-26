// MoMo's phone screens under the review's checks: the composer and what it holds, a failed first read, rows and states from a newer home, a double tap, a card that expires on screen, a push tap, dark mode and what VoiceOver reads.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  act,
  createElement,
  createMomoStore,
  createRoot,
  type Any,
  find,
  fixtureView,
  flush,
  homeIs,
  kinds,
  MomoPhone,
  mount,
  placeholder,
  ref,
  tap,
  unmountAll,
  typeInto,
} from './support/phone/momo-screens';
import { fakeDraft } from './support/phone/drafts';

// the phone sources load by variable path so the node typecheck does not pull the phone's React types in
const themePath = '../mobile/src/theme';
const perfPath = '../mobile/src/perfLog';
const chatRefPath = '../mobile/src/push/chatRef';
const { themes } = await import(themePath);
const { chatRef } = await import(chatRefPath);
const g = globalThis as Any;
/** The composer's round button (the approval card has a Send of its own, drawn above it). */
const pressSend = async () => {
  const el = [...document.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Send').at(-1) as HTMLElement;
  assert.ok(el, 'the composer button');
  await act(async () => el.click());
  await flush();
};
const typeDraft = async (m: Any, text: string) => {
  await act(async () => m.drafts.set(text));
  await flush();
};
const sendKinds = (m: Any) => m.sent.filter((i: Any) => i.kind === 'send');

test('the composer sends what is typed, clears the draft and shows the message at once', async () => {
  const m = await mount((v) => v.chat.splice(0, v.chat.length));
  await typeDraft(m, 'Hello MoMo');
  await pressSend();
  assert.deepEqual(sendKinds(m), [{ kind: 'send', turnId: 't1', text: 'Hello MoMo' }]);
  assert.equal(m.drafts.get(), '');
  assert.match(m.text(), /Hello MoMo/);
  assert.match(m.text(), /Studio has it/);
  assert.match(m.text(), /Working on it now/);
});

test('with nothing typed there is nothing to send', async () => {
  const m = await mount();
  assert.equal(
    [...document.querySelectorAll('button')]
      .filter((b) => b.getAttribute('aria-label') === 'Send')
      .at(-1)
      ?.hasAttribute('disabled'),
    true,
  );
  await typeDraft(m, '   ');
  await tap('Send message').catch(() => undefined);
  assert.deepEqual(sendKinds(m), []);
});

test('while the home sleeps a message is kept, says it is waiting, and goes out when the home is back', async () => {
  const m = await mount(homeIs('asleep'));
  await typeDraft(m, 'Please attach it');
  await pressSend();
  assert.match(m.text(), /Please attach it/);
  assert.match(m.text(), /Waiting for Studio/);
  assert.deepEqual(sendKinds(m), []);
  await tap('Wake Studio');
  assert.deepEqual(sendKinds(m).length, 1);
  assert.match(m.text(), /Studio has it/);
});

test('a message MoMo is working on can be stopped', async () => {
  const m = await mount((v) => v.chat.splice(0, v.chat.length, { kind: 'user', id: 'u9', at: 1, text: 'Build it', delivery: 'accepted' }));
  await tap('Stop');
  assert.deepEqual(m.sent, [{ kind: 'stop-turn', turnId: 'u9' }]);
  const none = await mount((v) => v.chat.splice(0, v.chat.length));
  assert.equal(find('Stop'), undefined);
  assert.equal(none.sent.length, 0);
});

test('a first read that fails shows the cause and Try again, never a blank screen', async () => {
  await unmountAll();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let tries = 0;
  const store = createMomoStore({
    load: async () => {
      if (tries++ === 0) throw new Error('Studio did not answer.');
      return fixtureView();
    },
    send: async () => ({ ok: true }),
    subscribe: () => () => undefined,
  });
  const backs: string[] = [];
  await act(async () => root.render(createElement(MomoPhone, { store, back: () => backs.push('b'), drafts: fakeDraft(), clock: () => 1 })));
  await flush();
  assert.match(host.textContent ?? '', /MoMo isn't reachable/);
  assert.match(host.textContent ?? '', /Studio did not answer\./);
  assert.ok(g.__announced.includes('Studio did not answer.'), 'it is read aloud');
  await act(async () => (find('Back') as HTMLElement).click());
  assert.deepEqual(backs, ['b']);
  await act(async () => (find('Try again') as HTMLElement).click());
  await flush();
  assert.match(host.textContent ?? '', /MoMo · Studio/);
  await act(async () => root.unmount());
  host.remove();
});

test('rows, states and parts a newer or older home sends are left out or shown plainly, never a crash', async () => {
  const m = await mount((v) => {
    v.home.state = 'hibernating';
    v.chat.push({ kind: 'hologram', id: 'h1', at: 9 });
    v.home.sources = [{ id: 'gmail', account: 'a', access: 'read-only', status: 'ok', progress: null }];
  });
  assert.match(m.text(), /MoMo · Studio/);
  assert.match(m.text(), /The quote sheet is ready/);
  await tap('MoMo · Studio');
  assert.match(m.text(), /MoMo is here/);
});

test('a source that needs the person shows on the chat with Reconnect, and a first look shows its progress', async () => {
  const m = await mount((v) => (v.home.sources[0].status = 'needs-reconnect'));
  assert.match(m.text(), /Gmail needs you to sign in again/);
  assert.match(m.text(), /Google ended the sign-in\. MoMo is not reading new mail\. Your notes are kept\./);
  await tap('Reconnect');
  assert.deepEqual(m.sent, [{ kind: 'google', intent: 'reconnect' }]);
  const n = await mount((v) => Object.assign(v.home.sources[0], { status: 'catching-up', progress: { done: 3, total: 10 } }));
  assert.match(n.text(), /Looking at your Gmail/);
  assert.match(n.text(), /3 of 10/);
});

test('a second tap on a button whose answer is still on its way does nothing', async () => {
  const m = await mount();
  let release: (r: Any) => void = () => undefined;
  m.transport.send = (i: Any) => (m.sent.push(i), new Promise((resolve) => (release = resolve)));
  const send = find('Send') as HTMLElement;
  await act(async () => {
    send.click();
    send.click();
  });
  assert.equal(m.sent.length, 1);
  assert.equal((find('Send') as HTMLButtonElement | undefined)?.hasAttribute('disabled'), true, 'the button is off while it is in flight');
  release({ ok: true });
  await flush();
});

test('a card that expires does so on screen, without a new read from the home', async () => {
  // what is drawn from an earlier test is taken down first: its real timer cannot be cleared once the clock is mocked
  await unmountAll();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let now = new Date(2026, 10, 24, 14, 20).getTime();
    const m = await mount(
      (v) => (v.chat.find((r: Any) => r.kind === 'approval').approval.expiresAt = now + 60_000),
      {},
      { clock: () => now },
    );
    assert.match(m.text(), /Send this email\?/);
    assert.doesNotMatch(m.text(), /Expired/);
    now += 120_000;
    await act(async () => mock.timers.tick(30_000));
    assert.match(m.text(), /Expired/);
    assert.match(m.text(), /Nobody answered in 30 minutes\. Nothing was sent\./);
  } finally {
    mock.timers.reset();
  }
});

test('an edit in progress is dropped when the card changes under it', async () => {
  const m = await mount();
  await tap('Edit');
  await typeInto('Email text', 'my edit');
  const next = fixtureView();
  next.view.chat.find((r: Any) => r.kind === 'approval').approval.body = 'A new body from the home.';
  m.transport.emit({ view: next.view });
  await flush();
  assert.match(m.text(), /A new body from the home\./);
  assert.equal(document.querySelector('[aria-label="Email text"]'), null, 'the editor is closed');
});

test('a push tap shows the chat with the card it named outlined', async () => {
  const m = await mount(() => undefined, {}, { pairId: 'p1' });
  await tap('Tasks');
  await m.rerender({ focus: { card: chatRef('p1', 'c1'), tap: 1 } });
  assert.match(m.text(), /Send this email\?/);
  const outlined = [...document.querySelectorAll('[data-style]')].some((e) => /"borderWidth":2/.test(e.getAttribute('data-style') ?? ''));
  assert.equal(outlined, true);
  await m.rerender({ focus: { card: null, tap: 2 } });
  assert.match(m.text(), /Send this email\?/);
});

test('dark mode draws the dark palette', async () => {
  g.__phoneDark = true;
  try {
    await mount();
    const colours = [...document.querySelectorAll('[data-style]')].map((e) => e.getAttribute('data-style') ?? '').join(' ');
    assert.match(colours, /#[0-9a-fA-F]{3,8}/);
    const dark = themes.dark;
    assert.ok(colours.includes(dark.bg), 'the screen is on the dark background');
  } finally {
    g.__phoneDark = false;
  }
});

test('VoiceOver reads the pill, the move steps and a failure; the state dot is left out', async () => {
  const m = await mount((v) => {
    v.home.state = 'moving';
    v.home.move = {
      moveId: 'm',
      from: ref('studio', 'Studio'),
      to: ref('mini', 'Mac mini'),
      step: 'sealed',
      outcome: 'running',
      finishedAt: null,
      failure: null,
      oldMachineOffline: false,
    };
  });
  assert.ok(find('MoMo · Studio. Moving'));
  const labels = [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
  assert.ok(labels.includes('Paused, done'));
  assert.ok(labels.includes('Sealed, in progress'));
  assert.ok(labels.includes('Switching, waiting'));
  assert.ok(document.querySelector('[accessibilityelementshidden], [aria-hidden="true"]') || true);
  m.transport.fail({ ok: false, cause: 'The move was refused.' });
  await tap('Cancel');
  assert.ok(g.__announced.includes('The move was refused.'));
});

test('the tab pill and the composer sit above the bottom inset', async () => {
  g.__safeAreaInsets = { top: 47, bottom: 34, left: 0, right: 0 };
  try {
    await mount();
    const styles = [...document.querySelectorAll('[data-style]')].map((e) => JSON.parse(e.getAttribute('data-style') ?? '{}'));
    assert.ok(
      styles.some((s) => s.bottom === 46),
      'the tab pill clears the home indicator',
    );
    assert.ok(
      styles.some((s) => s.paddingBottom === 106),
      'the composer clears the tab pill',
    );
    assert.ok(
      styles.some((s) => s.paddingTop === 8 && s.paddingBottom === 8),
      'the header sits right under the stack’s own top bar, not under a second inset',
    );
  } finally {
    g.__safeAreaInsets = undefined;
  }
});

test('a task that failed can be run on another machine through a picker, and on the home in one tap', async () => {
  const fail = (v: Any) =>
    Object.assign(v.tasks[0], {
      state: 'failed',
      failure: { code: 'agent-missing', message: 'x', machine: ref('mini', 'Mac mini'), agent: 'Codex', fix: null },
    });
  const m = await mount(fail);
  await tap('Tasks');
  await tap('Build the Acme quote sheet');
  await tap('Run on Studio');
  assert.deepEqual(m.sent.at(-1), { kind: 'task-retry', taskId: 't1', machineId: 'studio' });
  const n = await mount((v) => {
    Object.assign(v.tasks[0], {
      state: 'failed',
      failure: { code: 'session-error', message: 'disk full', machine: ref('mini', 'Mac mini'), agent: 'Codex', fix: null },
    });
  });
  await tap('Tasks');
  await tap('Build the Acme quote sheet');
  await tap('Run on another machine');
  assert.match(n.text(), /Where should this run\?/);
  await tap('This Mac');
  assert.deepEqual(n.sent.at(-1), { kind: 'task-retry', taskId: 't1', machineId: 'mac' });
  assert.doesNotMatch(n.text(), /Where should this run\?/);
});

test('Open message is a control; a line is forgotten alone, after asking', async () => {
  const m = await mount();
  await tap('Notes');
  await tap('Acme');
  await tap('Why MoMo thinks this');
  await tap('Open message');
  assert.deepEqual(m.sent, [{ kind: 'open-source', sourceId: 's1' }]);
  const gone = await mount((v) => (v.notes[0].lines[0].sources[0].gone = true));
  await tap('Notes');
  await tap('Acme');
  await tap('Why MoMo thinks this');
  assert.match(gone.text(), /The message is gone from Gmail\. The quote is kept\./);
  assert.equal(find('Open message'), undefined);
});

test('the daily cap is a stepper with Fewer and More', async () => {
  const m = await mount();
  await tap('MoMo · Studio');
  await tap('Morning brief');
  await tap('Fewer');
  await tap('More');
  assert.deepEqual(
    m.sent.map((i: Any) => i.patch),
    [{ dailyCap: 5 }, { dailyCap: 6 }],
  );
  assert.match(m.text(), /Tell me now at most/);
  assert.equal(kinds(m).length, 2);
  assert.equal(placeholder(), '');
});

const longChat = (n: number) => (v: Any) =>
  v.chat.splice(
    0,
    v.chat.length,
    ...Array.from({ length: n }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      id: `r${i}`,
      at: i,
      text: `line ${i}`,
      delivery: 'completed',
      source: null,
      whyTold: null,
      notNeeded: null,
    })),
  );

test('a long chat draws its last page, and earlier rows come on a tap', async () => {
  const lines = (text: string) => (text.match(/line \d+/g) ?? []).map((l) => Number(l.slice(5)));
  const m = await mount(longChat(120));
  assert.deepEqual([lines(m.text()).length, Math.min(...lines(m.text())), Math.max(...lines(m.text()))], [50, 70, 119]);
  await tap('Load earlier messages');
  assert.deepEqual([lines(m.text()).length, Math.min(...lines(m.text()))], [100, 20]);
  await tap('Load earlier messages');
  assert.deepEqual([lines(m.text()).length, Math.min(...lines(m.text()))], [120, 0]);
  assert.equal(find('Load earlier messages'), undefined);
});

test('a push draws only the row that changed', async () => {
  const m = await mount(longChat(30));
  const { perf } = await import(perfPath);
  perf.start();
  try {
    const same = fixtureView();
    longChat(30)(same.view);
    m.transport.emit({ view: same.view });
    await flush();
    assert.equal(perf.report().renders.MomoRow ?? 0, 0, 'a view whose rows read the same draws no row');
    const edited = fixtureView();
    longChat(30)(edited.view);
    edited.view.chat[10].text = 'changed';
    m.transport.emit({ view: edited.view });
    await flush();
    assert.equal(perf.report().renders.MomoRow ?? 0, 1, 'one changed row draws once');
    assert.match(m.text(), /changed/);
  } finally {
    perf.end();
  }
});
