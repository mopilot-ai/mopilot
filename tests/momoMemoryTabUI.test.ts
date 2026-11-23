// MoMo's Memory tab (#2139, src/components/momo/MemoryTab.tsx), the real component over a fake window.native.momoMemory: the two documents saved on Save (a failed save keeps the draft) and followed when they change elsewhere, facts with their source chips, search with the newest read winning, Add, Edit in place, Delete confirmed in place, failures shown with Retry, nothing at all while MoMo is not allowed and one line while memory is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], listeners: new Set() };
const ok = (x: object = {}) => ({ ok: true, ...x });
f.native = {
  // what MoMo wrote to Calendar and Reminders (WrittenChanges.tsx, tested in momoWrittenChangesUI.test.ts): nothing here
  momoSources: { writes: async () => ok({ writes: [] }) },
  momoMemory: {
    list: (q: any) => (f.calls.push(['list', q?.query ?? '']), f.listAnswer(q?.query ?? '')),
    add: async (text: string) => (f.calls.push(['add', text]), f.addAnswer(text)),
    update: async (id: string, patch: any) => (f.calls.push(['update', id, patch]), f.updateAnswer(id, patch)),
    forget: async (id: string) => (f.calls.push(['forget', id]), f.forgetAnswer(id)),
    files: () => (f.calls.push(['files']), f.filesAnswer()),
    writeFile: async (name: string, text: string) => (f.calls.push(['writeFile', name, text]), f.writeAnswer(name, text)),
    // the history below the facts (MemoryChanges.tsx, tested in momoMemoryChangesUI.test.ts): empty here
    changes: async () => ok({ changes: [] }),
    past: async () => ok({ facts: [] }),
    // the open loops below the facts (OpenLoops.tsx, tested in momoOpenLoopsUI.test.ts): none here
    loops: async () => ok({ open: [], closed: [], now: 0 }),
    onChanged: (cb: () => void) => {
      f.listeners.add(cb);
      return () => f.listeners.delete(cb);
    },
  },
};
installNativeStub(f.native);
const { MemoryTab, harnessName } = await import('../src/components/momo/MemoryTab.tsx');

const fact = (id: string, text: string, over: any = {}) => ({
  id,
  text,
  source: { chatId: 'momo-main', harness: 'claude' },
  createdAt: new Date(2026, 9, 20, 23, 30).getTime(),
  confidence: 'likely',
  ...over,
});
function reset() {
  f.calls = [];
  f.facts = [
    fact('f1', 'Lives in Berlin', { confidence: 'sure', source: { chatId: 'c', harness: 'codex' } }),
    fact('f2', 'Was in Rome', { expiresAt: 10, source: { chatId: 'c', harness: 'acp:kimi' } }),
    fact('fx', 'Plays chess', { origin: 'extracted' }),
  ];
  f.listAnswer = async (q: string) => ok({ facts: q ? f.facts.filter((x: any) => x.text.includes(q)) : f.facts, unreadable: 0, now: 100 });
  f.filesAnswer = async () => ok({ aboutYou: 'Du', persona: '', unreadable: [] });
  f.addAnswer = async (text: string) => {
    const added = fact(`f${f.facts.length}`, text, { source: 'user', confidence: 'sure' });
    f.facts = [added, ...f.facts];
    return ok({ fact: added, saved: true });
  };
  f.writeAnswer = async () => ok();
  f.updateAnswer = async (id: string, patch: any) => {
    f.facts = f.facts.map((x: any) => (x.id === id ? { ...x, ...patch } : x));
    return ok({ fact: f.facts.find((x: any) => x.id === id) });
  };
  f.forgetAnswer = async (id: string) => ((f.facts = f.facts.filter((x: any) => x.id !== id)), ok());
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

async function mount() {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MemoryTab)));
  await flush();
  const q = (sel: string, el: any = host) => el.querySelector(sel);
  const all = (sel: string, el: any = host) => [...el.querySelectorAll(sel)];
  const button = (label: string, el: any = host) =>
    all('button', el).find((b: any) => b.textContent === label || b.getAttribute('aria-label') === label);
  const click = async (el: any) => {
    await act(async () => el.click());
    await flush();
  };
  const type = async (el: any, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await flush();
  };
  const factRow = (id: string) => q(`.momo-fact[data-fact="${id}"]`);
  const close = () => act(async () => root.unmount());
  return { host, q, all, button, click, type, factRow, close };
}

test('facts show their source chips: harness, sure or likely, the day saved, and Expired', async () => {
  reset();
  const v = await mount();
  const chips = (id: string) => v.all('.momo-chip', v.factRow(id)).map((c: any) => c.textContent);
  assert.deepEqual(chips('f1'), ['Codex', 'Sure', '2026-10-20']);
  assert.deepEqual(chips('f2'), ['Kimi Code', 'Likely', '2026-10-20', 'Expired']);
  assert.deepEqual(chips('fx'), ['Claude Code', 'Inferred', 'Likely', '2026-10-20'], 'MoMo wrote it on its own');
  assert.equal(harnessName('claude'), 'Claude Code');
  assert.equal(harnessName('acp:newcomer'), 'newcomer', 'a basic harness the app has no entry for goes by its id');
  assert.equal(harnessName('acp:'), 'Unknown');
  assert.ok(v.q('[data-fact="f1"] .settings-row-title').textContent.includes('Lives in Berlin'));
  await v.close();
});

test('About you and the persona save on Save; Save waits for a change; a failed save keeps the draft and says why', async () => {
  reset();
  const v = await mount();
  const about = v.q('textarea[aria-label="About you"]');
  assert.equal(about.value, 'Du');
  const saveOf = (el: any) => v.button('Save', el.parentElement);
  assert.equal(saveOf(about).disabled, true, 'nothing changed yet');
  await v.type(about, 'Du, Berlin');
  f.writeAnswer = async () => ({ ok: false, error: 'EROFS' });
  await v.click(saveOf(about));
  assert.match(v.q('[role="alert"]').textContent, /Couldn't save: EROFS/);
  assert.equal(about.value, 'Du, Berlin', 'the draft stays');
  f.writeAnswer = async () => {
    throw new Error('IPC gone');
  };
  await v.click(saveOf(about));
  assert.match(v.q('[role="alert"]').textContent, /IPC gone/);
  f.writeAnswer = async () => ok();
  await v.click(saveOf(about));
  assert.deepEqual(f.calls.filter((c: any) => c[0] === 'writeFile').at(-1), ['writeFile', 'aboutYou', 'Du, Berlin']);
  assert.equal(v.q('[role="alert"]'), null);
  assert.equal(saveOf(about).disabled, true, 'saved: nothing new to save');
  const persona = v.q('textarea[aria-label="MoMo\'s persona"]');
  await v.type(persona, 'Brief.');
  await v.click(saveOf(persona));
  assert.deepEqual(f.calls.at(-1), ['writeFile', 'persona', 'Brief.']);
  await v.close();
});

test('search reads the matching facts, and an older read never replaces a newer one', async () => {
  reset();
  const v = await mount();
  const pending: Record<string, (r: any) => void> = {};
  f.listAnswer = (q: string) => new Promise((resolve) => (pending[q] = resolve));
  const box = v.q('input[aria-label="Search facts"]');
  await v.type(box, 'Ber');
  await v.type(box, 'Rome');
  pending.Rome(ok({ facts: [f.facts[1]], unreadable: 0, now: 100 }));
  await flush();
  pending.Ber(ok({ facts: [f.facts[0]], unreadable: 0, now: 100 }));
  pending.Ber({ ok: false, error: 'late' });
  await flush();
  assert.deepEqual(
    v.all('.momo-fact').map((r: any) => r.dataset.fact),
    ['f2'],
  );
  assert.equal(v.q('[role="alert"]'), null);
  f.listAnswer = async () => ok({ facts: [], unreadable: 0, now: 100 });
  await v.type(box, 'zzz');
  assert.ok(v.host.textContent.includes('No matching facts'));
  await v.type(box, '');
  assert.ok(v.host.textContent.includes('No facts yet'));
  await v.close();
});

test('correcting an expired fact brings it back; an unexpired one keeps its expiry', async () => {
  reset();
  const v = await mount();
  await v.click(v.button('Edit', v.factRow('f2')));
  await v.type(v.q('textarea[aria-label="Fact"]', v.factRow('f2')), 'Lives in Rome');
  await v.click(v.button('Save', v.factRow('f2')));
  await v.click(v.button('Edit', v.factRow('f1')));
  await v.type(v.q('textarea[aria-label="Fact"]', v.factRow('f1')), 'Lives in Munich');
  await v.click(v.button('Save', v.factRow('f1')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'update'),
    [
      ['update', 'f2', { text: 'Lives in Rome', expiresAt: null }],
      ['update', 'f1', { text: 'Lives in Munich' }],
    ],
  );
  await v.close();
});

test('Add saves what the user types as theirs: it shows with a You chip, the box empties; a failed add keeps the text', async () => {
  reset();
  const v = await mount();
  const box = v.q('input[aria-label="Add a fact"]');
  assert.equal(v.button('Add').disabled, true, 'nothing typed');
  await v.type(box, 'Prefers tea');
  f.addAnswer = async () => ({ ok: false, error: "MoMo's memory is off" });
  await v.click(v.button('Add'));
  assert.match(v.q('.momo-add [role="alert"]').textContent, /memory is off/);
  assert.equal(box.value, 'Prefers tea');
  f.addAnswer = async () => {
    throw new Error('IPC gone');
  };
  await v.click(v.button('Add'));
  assert.match(v.q('.momo-add [role="alert"]').textContent, /IPC gone/);
  reset();
  await act(async () => box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await flush();
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'add'),
    ['add', 'Prefers tea'],
  );
  assert.equal(box.value, '');
  assert.equal(v.q('.momo-add [role="alert"]'), null);
  assert.deepEqual(
    v.all('.momo-chip', v.factRow('f3')).map((c: any) => c.textContent),
    ['You', 'Sure', '2026-10-20'],
  );
  f.calls = [];
  await act(async () => box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await act(async () => box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true })));
  assert.ok(!f.calls.some((c: any) => c[0] === 'add'), 'Enter on an empty box adds nothing');
  await v.close();
});

test('Edit changes a fact in place; Cancel puts it back; a failed edit keeps the draft and says why', async () => {
  reset();
  const v = await mount();
  await v.click(v.button('Edit', v.factRow('f1')));
  const box = v.q('textarea[aria-label="Fact"]', v.factRow('f1'));
  assert.equal(v.button('Save', v.factRow('f1')).disabled, true, 'unchanged: nothing to save');
  await v.type(box, 'Lives in Hamburg');
  await v.click(v.button('Cancel', v.factRow('f1')));
  assert.equal(v.q('textarea[aria-label="Fact"]'), null);
  await v.click(v.button('Edit', v.factRow('f1')));
  await v.type(v.q('textarea[aria-label="Fact"]'), 'Lives in Hamburg');
  f.updateAnswer = async () => ({ ok: false, error: 'That fact is no longer in memory' });
  await v.click(v.button('Save', v.factRow('f1')));
  assert.match(v.q('[role="alert"]', v.factRow('f1')).textContent, /no longer in memory/);
  assert.equal(v.q('textarea[aria-label="Fact"]').value, 'Lives in Hamburg');
  reset();
  await v.click(v.button('Save', v.factRow('f1')));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'update'),
    ['update', 'f1', { text: 'Lives in Hamburg' }],
  );
  assert.equal(v.q('textarea[aria-label="Fact"]'), null);
  assert.ok(v.factRow('f1').textContent.includes('Lives in Hamburg'), 'the list is read again');
  await v.close();
});

const changed = () =>
  act(async () => {
    for (const cb of [...f.listeners]) cb();
  });

test('everything is read again when main says the memory changed, and the tab stops listening once closed', async () => {
  reset();
  const v = await mount();
  assert.equal(f.listeners.size, 6, 'the documents, the facts, the open loops, the recent changes, what MoMo wrote and the past facts');
  f.facts = [...f.facts, fact('f3', 'Saved by MoMo just now')];
  f.filesAnswer = async () => ok({ aboutYou: 'Du, Berlin', persona: 'Brief.', unreadable: [] });
  await changed();
  await flush();
  assert.ok(v.factRow('f3'), 'the fact MoMo saved shows without a search');
  assert.equal(v.q('textarea[aria-label="About you"]').value, 'Du, Berlin', 'an unedited document follows');
  assert.equal(v.q('textarea[aria-label="MoMo\'s persona"]').value, 'Brief.');
  await v.close();
  assert.equal(f.listeners.size, 0);
});

test('a draft whose document changed elsewhere says so, and Save replaces it; the notice goes once saved', async () => {
  reset();
  const v = await mount();
  const about = v.q('textarea[aria-label="About you"]');
  const foot = about.parentElement;
  await v.type(about, 'Du, mine');
  f.filesAnswer = async () => ok({ aboutYou: 'Du, theirs', persona: '', unreadable: [] });
  await changed();
  await flush();
  assert.equal(about.value, 'Du, mine', 'the draft stays');
  assert.equal(v.q('.config-warning', foot).textContent, 'Changed elsewhere. Saving replaces it.');
  // a slow save is busy, and its button says so
  let done!: () => void;
  f.writeAnswer = () => new Promise((r) => (done = () => r(ok())));
  await act(async () => v.button('Save', foot).click());
  assert.equal(v.button('Saving…', foot).disabled, true);
  f.filesAnswer = async () => ok({ aboutYou: 'Du, mine', persona: '', unreadable: [] });
  await act(async () => done());
  await flush();
  assert.equal(v.q('.config-warning', foot), null, 'saved: no notice while main reads it back');
  await changed();
  await flush();
  assert.equal(about.value, 'Du, mine');
  assert.equal(v.q('.config-warning', foot), null);
  assert.equal(v.button('Save', foot).disabled, true);
  // the user edits it back to what is saved: nothing to save, nothing stale
  await v.type(about, 'Du, other');
  await v.type(about, 'Du, mine');
  assert.equal(v.button('Save', foot).disabled, true);
  await v.close();
});

test("a document that can't be decrypted says saving replaces it, until it is saved", async () => {
  reset();
  f.filesAnswer = async () => ok({ aboutYou: '', persona: 'Brief.', unreadable: ['aboutYou'] });
  const v = await mount();
  const about = v.q('textarea[aria-label="About you"]');
  const warnings = () => v.all('.config-warning').map((w: any) => w.textContent);
  assert.deepEqual(warnings(), ["Couldn't decrypt this. Saving replaces it."]);
  await v.type(about, 'Du');
  await v.click(v.button('Save', about.parentElement));
  assert.deepEqual(warnings(), [], 'saved: the notice goes before main reads it back');
  f.filesAnswer = async () => ok({ aboutYou: 'Du', persona: 'Brief.', unreadable: [] });
  await changed();
  await flush();
  assert.deepEqual(warnings(), []);
  await v.close();
});

test('Delete asks in place first; Cancel keeps it; a delete that fails says why', async () => {
  reset();
  const v = await mount();
  await v.click(v.button('Delete "Was in Rome"'));
  assert.ok(!f.calls.some((c: any) => c[0] === 'forget'), 'asked, not deleted');
  await v.click(v.button('Cancel', v.factRow('f2')));
  assert.ok(v.button('Delete "Was in Rome"'), 'back to Edit and Delete');
  f.forgetAnswer = async () => {
    throw new Error('IPC gone');
  };
  await v.click(v.button('Delete "Was in Rome"'));
  await v.click(v.button('Confirm deleting "Was in Rome"'));
  assert.match(v.q('[role="alert"]', v.factRow('f2')).textContent, /IPC gone/);
  f.forgetAnswer = async () => ({ ok: false, error: 'That fact is no longer in memory' });
  await v.click(v.button('Delete "Was in Rome"'));
  await v.click(v.button('Confirm deleting "Was in Rome"'));
  assert.match(v.q('[role="alert"]', v.factRow('f2')).textContent, /no longer in memory/);
  reset();
  await v.click(v.button('Delete "Was in Rome"'));
  await v.click(v.button('Confirm deleting "Was in Rome"'));
  assert.equal(v.factRow('f2'), null);
  await v.close();
});

test('a read that fails says so with Retry, for the documents and the facts; unreadable lines are counted', async () => {
  reset();
  let fail = true;
  f.filesAnswer = async () => (fail ? { ok: false, error: 'EIO' } : ok({ aboutYou: 'Du', persona: '', unreadable: [] }));
  f.listAnswer = async () => (fail ? { ok: false, error: 'EACCES' } : ok({ facts: [], unreadable: 2, now: 1 }));
  const v = await mount();
  assert.match(v.host.textContent, /Couldn't read: EIO/);
  assert.equal(v.q('textarea[aria-label="About you"]'), null);
  assert.match(v.host.textContent, /Couldn't read the facts: EACCES/);
  fail = false;
  for (const b of v.all('button').filter((b: any) => b.textContent === 'Retry')) await v.click(b);
  assert.equal(v.q('textarea[aria-label="About you"]').value, 'Du');
  assert.match(v.host.textContent, /2 saved lines couldn't be read/);
  await v.close();
  reset();
  f.filesAnswer = () => Promise.reject(new Error('IPC gone'));
  f.listAnswer = async () => {
    throw new Error('no handler');
  };
  const w = await mount();
  assert.match(w.host.textContent, /Couldn't read: IPC gone/);
  assert.match(w.host.textContent, /Couldn't read the facts: no handler/);
  await w.close();
  reset();
  f.listAnswer = async () => ok({ facts: [], unreadable: 1, now: 1 });
  const one = await mount();
  assert.match(one.host.textContent, /1 saved line couldn't be read/);
  await one.close();
});

test('while MoMo is not allowed the tab shows nothing; while memory is off, one line and no adding', async () => {
  reset();
  f.filesAnswer = async () => ({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
  f.listAnswer = async () => ({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
  const v = await mount();
  assert.equal(v.host.innerHTML, '');
  await v.close();
  reset();
  f.listAnswer = async () => ({ ok: false, reason: 'unavailable', error: "MoMo's memory is off: this Mac can't encrypt it" });
  const w = await mount();
  assert.equal(w.host.textContent.includes('Memory is off'), true);
  assert.ok(!w.host.textContent.includes("can't encrypt it ("), 'no raw error');
  assert.equal(w.q('textarea'), null, 'no documents');
  const box = w.q('input[aria-label="Add a fact"]');
  assert.equal(box.readOnly, true);
  assert.equal(w.button('Add').disabled, true);
  await w.type(box, 'x');
  await act(async () => box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.ok(!f.calls.some((c: any) => c[0] === 'add'));
  // memory comes back on: the next change reads it all again
  reset();
  await changed();
  await flush();
  assert.ok(w.q('textarea[aria-label="About you"]'));
  await w.close();
});

test('a read that settles after the tab closed changes nothing', async () => {
  reset();
  let answer!: (r: any) => void;
  f.filesAnswer = () => new Promise((resolve) => (answer = resolve));
  const v = await mount();
  await v.close();
  answer(ok({ aboutYou: 'late', persona: '' }));
  await flush();
  let fail!: (e: any) => void;
  f.filesAnswer = () => new Promise((_r, reject) => (fail = reject));
  const w = await mount();
  await w.close();
  fail(new Error('late'));
  await flush();
  assert.equal(w.q('textarea'), null);
});
