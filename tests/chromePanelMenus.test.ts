// The Chrome side panel's model and permission menus (electron/chrome-extension/src/panelMenus.mjs and their use in sidePanel.mjs): the buttons and rows as MoPilot reports them, a pick sent to it, the pick a message goes with, and an older answer or a failure never showing over the latest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { PanelMenus } = await import('../electron/chrome-extension/src/panelMenus.mjs');
const { startSidePanel, PLACEHOLDER } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const OPTIONS = {
  harness: 'Claude Code',
  model: 'opus',
  effort: 'high',
  models: [
    {
      id: 'opus',
      label: 'Opus 5.5',
      description: 'Best for complex work',
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
      defaultEffort: 'high',
      more: false,
    },
    { id: 'sonnet', label: 'Sonnet 5.5', description: null, efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low', more: false },
    { id: 'claude-opus-4-1', label: 'Opus 4.1', description: null, efforts: [], defaultEffort: null, more: true },
  ],
  permission: {
    title: 'What Claude Code can do',
    value: 'default',
    rows: [
      { id: 'default', label: 'Ask for approval', detail: 'default · Asks before edits and commands' },
      { id: 'auto-review', label: 'Approve for me', detail: 'auto · …', disabled: "This model can't auto-approve" },
    ],
  },
};

/** Menus on a fake document; each request waits for the test to answer it. */
function menus() {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) };
  const asks: { method: string; params: any; answer: (r: any) => void; fail: (e: Error) => void }[] = [];
  const errors: string[] = [];
  const m = new PanelMenus({
    document,
    request: (method: string, params: any) => new Promise((answer, fail) => asks.push({ method, params, answer, fail })),
    onError: (text: string) => errors.push(text),
    onHarness: () => assert.fail('no harness row is picked here'),
  });
  /** A menu's rows as text: a heading as "# …", a row's name with ✓ when it is the pick, and its second line. */
  const rows = (id: string) =>
    els[id === 'model-menu' ? 'model-rows' : id].children.map((c: any) =>
      c.tagName === 'H4'
        ? `# ${c.textContent}`
        : `${c.children[0]?.textContent ?? c.textContent}${c.attrs['aria-checked'] === 'true' ? ' ✓' : ''}${c.children[1] ? ` (${c.children[1].textContent})` : ''}${c.disabled ? ' [off]' : ''}`,
    );
  return { m, els, asks, errors, rows };
}

test('Full access needs a deliberate second choice, and closing or changing the target retires it', async () => {
  const { m, asks, els } = menus();
  const options = {
    ...OPTIONS,
    permission: {
      ...OPTIONS.permission,
      rows: [...OPTIONS.permission.rows, { id: 'full-access', label: 'Full access', detail: 'No sandbox' }],
    },
  };
  const loaded = m.load({ harness: 'codex' });
  asks[0].answer(options);
  await loaded;
  await m.permit('full-access', true);
  assert.equal(asks.length, 1);
  await m.permit('full-access');
  assert.equal(asks.length, 1);
  assert.match(els['perm-menu'].textContent, /Enable Full access/);
  m.close();
  await m.permit('full-access', true);
  assert.equal(asks.length, 1);
  await m.permit('full-access');
  const changed = m.load({ chatId: 'existing' });
  asks[1].answer(options);
  await changed;
  await m.permit('full-access', true);
  assert.equal(asks.length, 2);
  await m.permit('full-access');
  const confirm = m.permit('full-access', true);
  assert.deepEqual(asks[2].params, { chatId: 'existing', value: 'full-access' });
  asks[2].answer({});
  await confirm;
  assert.equal(m.now?.permission?.value, 'full-access');
  const again = m.permit('full-access');
  asks[3].answer({});
  await again;
});

test('an existing chat owns its saved model; sending text never reapplies the panel snapshot', async () => {
  const { m, asks } = menus();
  const loaded = m.load({ chatId: 'existing' });
  asks[0].answer(OPTIONS);
  await loaded;
  assert.deepEqual(m.pick, {}, 'a later native model or harness change must not be undone by plain text');
});

test('observed native metadata refreshes only its current chat and coalesces equivalent snapshots', async () => {
  const { m, asks, errors } = menus();
  assert.equal(m.observe('chat', { harness: 'Claude Code' }), undefined);
  const loaded = m.load({ chatId: 'chat' });
  asks[0].answer(OPTIONS);
  await loaded;
  for (const state of [null, {}, { harness: 3 }]) assert.equal(m.observe('chat', state), undefined);
  assert.equal(m.observe('other', { harness: 'Claude Code' }), undefined);
  const first = m.observe('chat', { menuOwner: 'native-one', harness: 'Claude Code', model: 'opus', account: 'A' });
  assert.equal(m.observe('chat', { menuOwner: 'native-one', harness: 'Claude Code', model: 'opus', account: 'A' }), undefined);
  assert.equal(asks.length, 2);
  const next = m.observe('chat', { harness: 'Codex', model: 'sol', account: 'B' });
  asks[2].answer({ ...OPTIONS, harness: 'Codex' });
  await next;
  asks[1].fail(new Error('Retired options'));
  await first;
  assert.deepEqual(errors, []);
  assert.equal(m.now?.harness, 'Codex');
  assert.deepEqual(m.pick, {});
  const noAccount = m.observe('chat', { harness: 'Codex' });
  asks[3].answer({ ...OPTIONS, harness: 'Codex' });
  await noAccount;
  assert.equal(asks.length, 4);
  const changedChat = m.load({ chatId: 'different' });
  asks[4].answer(OPTIONS);
  await changedChat;
  assert.equal(m.observe('chat', { harness: 'Claude Code' }), undefined);
});

test('a native owner change refreshes a menu even when the human-facing labels are identical', async () => {
  const { m, asks } = menus();
  const loaded = m.load({ chatId: 'chat' });
  asks[0].answer(OPTIONS);
  await loaded;
  for (const menuOwner of ['native:A', 'native:B']) {
    const fresh = m.observe('chat', { harness: 'Claude Code', account: 'Same account', model: 'opus', menuOwner });
    asks.at(-1)!.answer(OPTIONS);
    await fresh;
  }
  assert.equal(asks.length, 3);
});

for (const action of ['model', 'mode'])
  test(`an observed replacement retires a pending ${action} selection's error`, async () => {
    const { m, asks, errors } = menus();
    const loaded = m.load({ chatId: 'chat' });
    asks[0].answer(OPTIONS);
    await loaded;
    const pending = action === 'model' ? m.choose('sonnet') : m.permit('default');
    const refreshed = m.observe('chat', { harness: 'Codex' });
    asks[2].answer({ ...OPTIONS, harness: 'Codex' });
    await refreshed;
    asks[1].fail(new Error('Earlier selection failed'));
    await pending;
    assert.deepEqual(errors, []);
    assert.equal(m.now?.harness, 'Codex');
  });

test('the model menu: it opens on the effort under the harness and model, which leads to the models and More models; a pick goes to MoPilot and goes with the next message', async () => {
  const { m, els, asks, errors, rows } = menus();
  assert.deepEqual(m.pick, {});
  // nothing loaded yet: a pick goes nowhere
  await m.choose('opus');
  await m.permit('default');
  assert.equal(asks.length, 0);
  const loaded = m.load({ harness: 'claude' });
  // until MoPilot answers: no model button, the permission one off
  assert.equal(els.model.hidden, false);
  assert.equal(asks[0].method, 'options');
  asks[0].answer(OPTIONS);
  await loaded;
  assert.equal(els.model.hidden, false);
  assert.equal(els.model.textContent, 'Opus 5.5 High');
  assert.deepEqual(m.pick, { model: 'opus', effort: 'high' });
  els.model.listeners.click();
  assert.equal(els['model-menu'].hidden, false);
  // the first level: the effort, under the harness and model it is for
  assert.deepEqual(rows('model-menu'), ['High (Claude Code · Opus 5.5)', '# Effort', 'Low', 'High ✓']);
  // the title row leads to the models, each description its tooltip; and back
  els['model-rows'].children[0].listeners.click();
  assert.deepEqual(rows('model-menu'), ['‹ Harness', '# Models', 'Opus 5.5 ✓', 'Sonnet 5.5', 'More models']);
  assert.equal(els['model-rows'].children[2].title, 'Best for complex work');
  assert.equal(els['model-rows'].children[3].title, undefined);
  els['model-rows'].children[0].listeners.click();
  assert.equal(rows('model-menu')[0], 'High (Claude Code · Opus 5.5)');
  els['model-rows'].children[0].listeners.click();
  // More models: the older versions
  els['model-rows'].children[4].listeners.click();
  assert.deepEqual(rows('model-menu').slice(4), ['Fewer models', 'Opus 4.1']);
  // closing and opening again starts on the effort
  els.model.listeners.click();
  els.model.listeners.click();
  assert.equal(rows('model-menu')[0], 'High (Claude Code · Opus 5.5)');
  // an effort: the model stays
  const low = els['model-rows'].children.find((c: any) => c.children[0]?.textContent === 'Low');
  low.listeners.click();
  assert.equal(els['model-menu'].hidden, true);
  assert.deepEqual(asks[1].params, { harness: 'claude', model: 'opus', effort: 'low' });
  asks[1].answer({ chosen: true });
  await tick();
  assert.equal(els.model.textContent, 'Opus 5.5 Low');
  // another model: the effort stays when it has it
  els.model.listeners.click();
  els['model-rows'].children[0].listeners.click();
  els['model-rows'].children[3].listeners.click();
  assert.deepEqual(asks[2].params, { harness: 'claude', model: 'sonnet', effort: 'low' });
  asks[2].answer({});
  await tick();
  // else that model's default
  const toOld = m.choose('claude-opus-4-1');
  assert.deepEqual(asks[3].params, { harness: 'claude', model: 'claude-opus-4-1', effort: null });
  asks[3].answer({});
  await toOld;
  assert.equal(els.model.textContent, 'Opus 4.1');
  assert.deepEqual(m.pick, { model: 'claude-opus-4-1' });
  // a model without effort levels says so on the first level
  els.model.listeners.click();
  assert.deepEqual(rows('model-menu'), ['Default (Claude Code · Opus 4.1)', 'This model has no effort levels']);
  m.close();
  const back = m.choose('opus');
  assert.deepEqual(asks[4].params.effort, 'high');
  // refused: the error line, and the menu as it was
  asks[4].fail(new Error("That option isn't one MoPilot has."));
  await back;
  assert.deepEqual(errors, ["That option isn't one MoPilot has."]);
  assert.equal(els.model.textContent, 'Opus 4.1');
});

test('the model menu before its options load: the title row names no model and leads to an empty list', async () => {
  const { m, els, asks, rows } = menus();
  m.setHarnesses([{ id: 'claude', label: 'Claude Code' }]);
  void m.load({ harness: 'claude' });
  els.model.listeners.click();
  assert.deepEqual(rows('model-menu'), ['Default (Claude Code)', '']);
  els['model-rows'].children[0].listeners.click();
  // one harness is no choice: no harness rows
  assert.deepEqual(rows('model-menu'), ['‹ Harness', '# Models']);
  asks[0].answer({ ...OPTIONS, harness: null, models: [], model: null });
  await tick();
  m.setHarnesses([]);
  els.model.listeners.click();
  els.model.listeners.click();
  assert.deepEqual(rows('model-menu'), ['Default (Choose model)', '']);
});

test('the permission menu: the rows with their difference, one the model can’t take is off; a basic harness without modes sets it itself', async () => {
  const { m, els, asks, errors, rows } = menus();
  const loaded = m.load({ chatId: 'claude:1' });
  asks[0].answer(OPTIONS);
  await loaded;
  assert.equal(els.perm.textContent, 'Ask for approval');
  els.perm.listeners.click();
  assert.equal(els['perm-menu'].hidden, false);
  assert.equal(els['model-menu'].hidden, true);
  assert.deepEqual(rows('perm-menu'), [
    '# What Claude Code can do',
    'Ask for approval ✓ (default · Asks before edits and commands)',
    "Approve for me (This model can't auto-approve) [off]",
  ]);
  // the other menu closes this one; the same button again closes it
  els.model.listeners.click();
  assert.equal(els['perm-menu'].hidden, true);
  els.model.listeners.click();
  assert.equal(els['model-menu'].hidden, true);
  const permitted = m.permit('auto-review');
  assert.deepEqual(asks[1].params, { chatId: 'claude:1', value: 'auto-review' });
  asks[1].answer({ permitted: true });
  await permitted;
  assert.equal(els.perm.textContent, 'Approve for me');
  const refused = m.permit('default');
  asks[2].fail(new Error('nope'));
  await refused;
  assert.deepEqual(errors, ['nope']);
  assert.equal(els.perm.textContent, 'Approve for me');

  // a basic harness that has no modes
  const loaded2 = m.load({ harness: 'acp:bare' });
  asks[3].answer({ harness: 'Bare', models: [], model: null, effort: null, permission: null });
  await loaded2;
  assert.equal(els.perm.textContent, 'Set by Bare');
  assert.equal(els.perm.disabled, true);
  assert.equal(els.model.hidden, false, 'the menu still offers a new chat harness');
  await m.permit('x');
  await m.choose('x');
  assert.equal(asks.length, 4);
  // an answer that names nothing
  const loaded3 = m.load({ harness: 'acp:bare' });
  asks[4].answer({});
  await loaded3;
  assert.equal(els.perm.textContent, 'Set by the harness');
  assert.equal(els.model.textContent, 'Choose model');
  // a value no row has: the menu's title
  const loaded4 = m.load({ harness: 'codex' });
  asks[5].answer({ ...OPTIONS, permission: { ...OPTIONS.permission, value: 'gone' } });
  await loaded4;
  assert.equal(els.perm.textContent, 'What Claude Code can do');
});

test('an older answer never shows over the latest; a pick made for another chat stays out of this one', async () => {
  const { m, els, asks, errors } = menus();
  const first = m.load({ chatId: 'a' });
  const second = m.load({ chatId: 'b' });
  asks[1].answer({ ...OPTIONS, model: 'sonnet', effort: 'low' });
  await second;
  asks[0].answer(OPTIONS);
  asks.at(-1);
  await first;
  assert.equal(els.model.textContent, 'Sonnet 5.5 Low');
  // a failure of an older load says nothing; the latest's does
  const third = m.load({ chatId: 'c' });
  const fourth = m.load({ chatId: 'd' });
  asks[2].fail(new Error('old'));
  asks[3].fail(new Error('latest'));
  await third;
  await fourth;
  assert.deepEqual(errors, ['latest']);
  // a pick that lands after another chat opened
  const fifth = m.load({ chatId: 'e' });
  asks[4].answer(OPTIONS);
  await fifth;
  const chose = m.choose('sonnet');
  const permitted = m.permit('default');
  const sixth = m.load({ chatId: 'f' });
  asks[5].answer({});
  asks[6].answer({});
  asks[7].answer({ ...OPTIONS, model: 'claude-opus-4-1', effort: null });
  await Promise.all([chose, permitted, sixth]);
  assert.equal(els.model.textContent, 'Opus 4.1');
});

test('the page: a new chat’s menus follow the harness; the pick goes with the first message and a follow-up; the box’s line', async () => {
  const p = panelPage({
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses')
        return {
          status: 'connected',
          result: {
            harnesses: [
              { id: 'claude', label: 'Claude Code' },
              { id: 'codex', label: 'Codex' },
            ],
          },
        };
      if (m.method === 'options') return { status: 'connected', result: OPTIONS };
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'claude:9' } };
      if (m.method === 'read') return { status: 'connected', result: { rows: [], harness: 'Claude Code', state: 'idle' } };
      return { status: 'connected', result: {} };
    },
    tab: null,
  });
  await startSidePanel(p.g).ready;
  await tick();
  await tick();
  const options = () =>
    p
      .sent()
      .filter((m: any) => m.method === 'options')
      .map((m: any) => m.params);
  assert.deepEqual(options(), [{ harness: 'claude' }]);
  assert.equal(p.els.text.placeholder, PLACEHOLDER.new);
  p.els.harness.value = 'codex';
  p.els.harness.listeners.change();
  await tick();
  assert.deepEqual(options().at(-1), { harness: 'codex' });
  p.els.text.value = 'Top stories?';
  p.els.text.listeners.input();
  p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  await tick();
  const start = p.sent().find((m: any) => m.method === 'start');
  assert.deepEqual(start.params, { retainOnError: true, harness: 'codex', text: 'Top stories?', model: 'opus', effort: 'high' });
  // the chat open: its own menus, a follow-up's line, and the pick with the follow-up
  assert.deepEqual(options().at(-1), { chatId: 'claude:9' });
  assert.equal(p.els.text.placeholder, PLACEHOLDER.reply);
  p.els.text.value = 'more';
  p.els.text.listeners.input();
  p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  await tick();
  const send = p.sent().find((m: any) => m.method === 'send');
  assert.deepEqual(send.params, { chatId: 'claude:9', text: 'more' });
});
