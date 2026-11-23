// Conversation-view UI unit cases for MoMo's chats (#4926): only MoMo's words are drawn (no CLI stub reply, no duration on a stop nobody measured), and the thread stamps its days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, setStore, T, text, user, reply, turn, chat, view, callsTo, impl } from './fixture.ts';

const NOW = new Date(2026, 10, 17, 15, 30).getTime();
const sec = (d: Date) => d.getTime() / 1000;
const at = (daysAgo: number, hour: number, minute = 0) => sec(new Date(2026, 10, 17 - daysAgo, hour, minute));

export function registerMomo() {
  test('MoMo’s chat draws no CLI stub reply; an ordinary chat shows what its harness wrote', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const v = await render(view());
    const items = [user('u1', 'hello'), reply('a2', 'Hi, I am MoMo.'), reply('a1', 'No response requested.')];
    await settle(() => chat([turn('t1', items, { startedAt: at(0, 15, 17), completedAt: at(0, 15, 18) })]));
    const html = () => v.$('.turn')!.outerHTML;
    assert.ok(html().includes('No response requested.'), 'an ordinary chat is unchanged');
    await settle(() => setStore({ momoChats: { [T]: 'main' } }));
    assert.ok(!html().includes('No response requested'));
    assert.ok(html().includes('Hi, I am MoMo.'));
    await v.unmount();
  });

  test('a stop reads "Stopped" with no duration where nothing measured its end, and in MoMo only when its person stopped it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const v = await render(view());
    const items = [user('u1', 'go'), { id: 'c', type: 'commandExecution', command: 'ls', status: 'completed' }];
    const label = async (extra: any) => {
      await settle(() => chat([turn('t', items, { startedAt: at(1, 21, 0), status: 'interrupted', ...extra })]));
      return v.$('.worked-for span') ? text(v.$('.worked-for span')!) : null;
    };
    // an ordinary chat: the turn began 18 h ago and nothing measured its end, so no duration (it used to read "Stopped after 18h 33m")
    assert.equal(await label({}), 'Stopped');
    assert.equal(await label({ stoppedByYou: true }), 'You stopped');
    await settle(() => setStore({ momoChats: { [T]: 'main' } }));
    // MoMo: the app quitting is no news, and a stop its person made says only "Stopped"
    assert.equal(await label({}), null);
    assert.equal(await label({ stoppedByYou: true }), 'Stopped');
    assert.equal(await label({ stoppedByYou: true, completedAt: at(1, 21, 1) }), 'Stopped', 'never a duration there');
    await v.unmount();
  });

  test('MoMo’s thread stamps its days and long quiets, grey; an ordinary chat has none', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const v = await render(view());
    const turns = [
      turn('t1', [user('u1', 'one'), reply('a1', 'A')], { startedAt: at(1, 21, 0), completedAt: at(1, 21, 1) }),
      turn('t2', [user('u2', 'two'), reply('a2', 'B')], { startedAt: at(1, 21, 30), completedAt: at(1, 21, 31) }),
      turn('t3', [user('u3', 'three'), reply('a3', 'C')], { startedAt: at(0, 3, 17), completedAt: at(0, 3, 18) }),
      turn('t4', [user('u4', 'four'), reply('a4', 'D')], { startedAt: at(0, 15, 17), completedAt: at(0, 15, 18) }),
      turn('t5', [user('u5', 'five'), reply('a5', 'E')], {
        startedAt: sec(new Date(2025, 0, 3, 9, 5)),
        completedAt: sec(new Date(2025, 0, 3, 9, 6)),
      }),
    ];
    await settle(() => chat(turns.slice(0, 4)));
    assert.equal(v.$$('.momo-day').length, 0, 'an ordinary chat has no stamps');
    await settle(() => setStore({ momoChats: { [T]: 'main' } }));
    const stamps = () => v.$$('.momo-day').map((e) => e.getAttribute('aria-label'));
    // the first turn, then none within the same day and under six hours, then a new day, then a long quiet within a day
    assert.deepEqual(stamps(), [`Yesterday ${stamp(at(1, 21, 0))}`, `Today ${stamp(at(0, 3, 17))}`, `Today ${stamp(at(0, 15, 17))}`]);
    assert.equal(v.$('.momo-day')!.getAttribute('role'), 'separator');
    // a turn with no start time and a turn of an earlier year
    await settle(() => chat([...turns.slice(0, 1), turn('t0', [user('u0', 'x')], {}), turns[4]]));
    assert.equal(stamps().length, 2);
    assert.match(stamps()[1]!, /2025/);
    // an earlier day of this year has no year in it
    const week = turn('t6', [user('u6', 'six'), reply('a6', 'F')], { startedAt: at(5, 10, 5), completedAt: at(5, 10, 6) });
    await settle(() => chat([week]));
    assert.doesNotMatch(stamps()[0]!, /2026|Today|Yesterday/);
    assert.match(stamps()[0]!, new RegExp(stamp(at(5, 10, 5))));
    await v.unmount();
  });

  test('MoMo’s question draws its Options line as chips: a tap sends the label, a refused send keeps them, and the next turn takes them away', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const v = await render(view());
    const ask = [user('u1', 'plan my day'), reply('a1', 'Shall I move your 3 pm?\nOptions: Yes | No | Not now')];
    const done = { startedAt: at(0, 15, 17), completedAt: at(0, 15, 18) };
    const chips = () => v.$$('[data-option-chips] button').map(text);
    await settle(() => chat([turn('t1', ask, done)]));
    assert.deepEqual(chips(), [], 'an ordinary chat shows its text as written');
    assert.ok(v.$('.turn')!.outerHTML.includes('Options: Yes'));
    await settle(() => setStore({ momoChats: { [T]: 'main' } }));
    assert.deepEqual(chips(), ['Yes', 'No', 'Not now']);
    assert.equal(v.$$('.message-actions').length, 0, 'no action row under a question that waits for its answer');
    assert.ok(!v.$('.turn')!.outerHTML.includes('Options:'), 'the line is no text');
    assert.equal(v.$('[data-option-chips]')!.getAttribute('aria-label'), 'Suggested answers');
    // main refuses the send (it said why): the chips come back for another try
    impl['store:sendMessage'] = async () => false;
    await settle(() => (v.$$('[data-option-chips] button')[1] as HTMLElement).click());
    assert.deepEqual(callsTo('store:sendMessage')[0], [T, 'No', [], { human: true }]);
    assert.equal((v.$$('[data-option-chips] button')[0] as HTMLButtonElement).disabled, false);
    impl['store:sendMessage'] = async () => true;
    await settle(() => (v.$$('[data-option-chips] button')[0] as HTMLElement).click());
    assert.deepEqual(callsTo('store:sendMessage')[1], [T, 'Yes', [], { human: true }]);
    assert.ok(
      v.$$('[data-option-chips] button').every((b) => (b as HTMLButtonElement).disabled),
      'one answer per question',
    );
    // a later turn (any sender) takes them away, and a running or read-only chat has none
    await settle(() => chat([turn('t1', ask, done), turn('t2', [user('u2', 'Yes'), reply('a2', 'Done.')], done)]));
    assert.deepEqual(chips(), []);
    assert.equal(v.$$('.message-actions').length, 2, 'the question’s action row returns once it is answered');
    await settle(() => chat([turn('t1', ask, done)]));
    assert.deepEqual(chips(), ['Yes', 'No', 'Not now']);
    await v.rerender(view({ readOnly: true }));
    assert.deepEqual(chips(), []);
    await v.unmount();
  });
}

/** A time as the stamp writes it. */
const stamp = (sec: number) => new Date(sec * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
