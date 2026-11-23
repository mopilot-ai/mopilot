// DEV ONLY: scripted situations a phone tester starts from the host console (`run <name> [args]`). Each makes a chat of its own, titled "[bench] …", and does its thing in it; the host prints what to look at on the phone.

import { momoScenarios } from './scenariosMomo.mjs';
import { TABLE_REPLY } from './fakeData.mjs';
import { historyScenarios } from './scenarioHistory.mjs';
import { pushScenarios } from './scenariosPush.mjs';
import { surfaceScenario } from './scenarioSurface.mjs';
import { projectsScenario } from './scenarioProjects.mjs';
import { silentScenario } from './scenarioSilent.mjs';
import { sideChatScenario } from './scenarioSideChat.mjs';
/** The projects the bulk chats are spread over: a name and the id the Mac sends for it (none for a chat in no project). */
const BULK_PROJECTS = [
  { project: null, projectId: null },
  { project: 'dev-repo', projectId: 'dev-repo' },
  { project: 'site', projectId: 'site' },
  { project: 'docs', projectId: 'docs' },
  { project: 'app', projectId: 'app-1' },
  { project: 'app', projectId: 'app-2' },
];

const PLAN = `# Plan: round the checkout total once

## Why
The total multiplies before rounding, so a 10% discount on 3 × 9.99 drifts by a cent.

## Steps
1. Add a \`discount\` parameter to \`total()\` in src/price.ts.
2. Round once, at the end, to two decimals.
3. Cover the drift case in tests/price.test.ts.
4. Run the tests and show the diff.

## Not doing
- No change to the tax rate.
- No change to the checkout page.
`;

/** The most a plan card carries before it says "only the start is shown". */
const PLAN_CLIP = 4000;

const toNumber = (/** @type {string | undefined} */ text, /** @type {number} */ fallback, /** @type {number} */ max) => {
  const n = Number(text);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
};

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./fakeApp.mjs').createFakeApp>} o.app
 * @param {() => number} [o.now]
 * @param {(ms: number, fn: () => void) => unknown} [o.after] runs `fn` later (tests run it at once)
 * @param {ReturnType<typeof import('./controls.mjs').createControls>} [o.controls] the host's switches (MoMo, sleep, restart, revoke)
 */
export function createScenarios({ app, now = Date.now, after = (ms, fn) => setTimeout(fn, ms).unref(), controls }) {
  const need = () => /** @type {NonNullable<typeof controls>} */ (controls);
  const onOff = (/** @type {string | undefined} */ arg, /** @type {string} */ usage) => {
    if (arg !== 'on' && arg !== 'off') throw new Error(`Say on or off: run ${usage}`);
    return arg === 'on';
  };
  /** A chat of its own for a scenario, with the message that "started" it. */
  /** the one chat `flood` keeps streaming into, so a phone that follows it gets every round */
  /** @type {any} */
  let floodChat = null;
  const chatFor = (/** @type {string} */ name, /** @type {string} */ prompt, harness = 'codex') => {
    const chat = app.add({ id: `dev-bench-${app.counter()}`, title: `[bench] ${name}`, harness, at: now() });
    app.row(chat, 'user', prompt);
    return chat;
  };

  /** @type {Record<string, { usage: string, about: string, run: (args: string[]) => string | Promise<string> }>} */
  const all = {
    'fail-mid-stream': {
      usage: 'fail-mid-stream',
      about: 'a turn that streams half an answer and then fails',
      run() {
        const chat = chatFor('fails mid-stream', 'Explain the rounding bug in detail.');
        void app.enqueue(chat, async (t) => {
          await t.say('The total multiplies before it rounds, so a discount applied to three items drifts by a cent. The cause is that', {
            delay: 120,
            record: false,
          });
          t.fail('The model connection dropped (bench scenario)');
        });
        return `chat ${chat.id}: streams for a few seconds, then the turn fails with a reason`;
      },
    },
    'slow-stream': {
      usage: 'slow-stream [seconds=30]',
      about: 'a long slow answer, so the phone can press Stop in the middle',
      run([seconds]) {
        const secs = toNumber(seconds, 30, 300);
        const chat = chatFor('slow stream', 'Write a long answer slowly.');
        const text = Array.from({ length: secs * 4 }, (_, i) => `word${i + 1}`).join(' ');
        void app.enqueue(chat, (t) => t.say(text, { delay: 250 }));
        return `chat ${chat.id}: streams ~${secs}s; Stop from the phone ends it as stopped, what was shown stays`;
      },
    },
    flood: {
      usage: 'flood [items=1000]',
      about: 'many separate short items in one turn (about three frames each), to give a phone that was away a large backlog',
      run([count]) {
        const n = toNumber(count, 1000, 5000);
        const chat = (floodChat ??= chatFor('flood', 'Write many short lines.'));
        void app.enqueue(chat, async (t) => {
          for (let i = 0; i < n; i++) await t.say(`line${i + 1} `, { delay: 0, record: false });
        });
        return `chat ${chat.id}: ${n} items (~${n * 3} frames) streamed to whoever follows it`;
      },
    },
    'follow-error': {
      usage: 'follow-error [reads=1]',
      about: 'the next chat reads fail with an error, so a phone opening a chat shows its Retry; the read after them works',
      run([reads]) {
        const n = toNumber(reads, 1, 20);
        app.failReads(n, "The Mac couldn't read this chat just now (bench scenario).");
        return `the next ${n} chat read${n === 1 ? '' : 's'} fail; open a chat on the phone, then press Retry`;
      },
    },
    'stream-reply': {
      usage: 'stream-reply [fast|bursty|table]',
      about:
        "a Markdown reply streamed fast and evenly, or in clumps with pauses, to judge how the phone reveals it; table streams the owner's table and CJK reply (#4644) word by word",
      run([mode]) {
        const bursty = mode === 'bursty';
        if (mode === 'table') {
          const chat = chatFor('table stream', 'Which microwave trim kit fits?');
          void app.enqueue(chat, (t) => t.say(TABLE_REPLY, { delay: 160 }));
          return `chat ${chat.id}: the table and CJK reply streams a word every 160 ms; open it on the phone and watch the table arrive`;
        }
        const chat = chatFor(bursty ? 'bursty stream' : 'fast stream', 'Explain rounding in checkout totals with an example.');
        const para =
          'The total multiplies **before** it rounds, so a 10% discount on three items at `9.99` drifts by a cent. Rounding once, at the end, keeps every line item and the total in agreement.';
        const text = [
          para,
          `1. Add a \`discount\` parameter.\n2. Round once at the end.\n3. Cover the drift case in tests.`,
          '```ts\nconst total = round(sum(items) * (1 - discount));\n```',
          para,
          para,
        ].join('\n\n');
        void app.enqueue(chat, (t) => t.say(text, bursty ? { delay: 700, burst: 14 } : { delay: 14 }));
        return `chat ${chat.id}: ${bursty ? '14 words every 700 ms' : 'a word every 14 ms'}; open it on the phone and watch the reveal`;
      },
    },
    work: {
      usage: 'work [steps=8] [seconds-per-step=2]',
      about:
        'a long turn of many steps (reads, searches, runs) that waits for an approval halfway and then goes on, to judge the activity group, its settled and waiting states and its disclosure',
      run([steps, secs]) {
        const n = toNumber(steps, 8, 40);
        const pause = toNumber(secs, 2, 20) * 1000;
        const chat = chatFor('long turn', 'Find why the discount rounds wrong and fix it.');
        const commands = [
          'cat src/price.ts',
          'rg -n "discount" src',
          'sed -n 1,80p src/checkout.ts',
          'git log --oneline -5',
          'npm test -- --grep discount',
          'rg -n "round(" src',
          'cat package.json',
          'ls tests',
        ];
        void app.enqueue(chat, async (t) => {
          await t.say('I will read the code first, then run the tests around the discount.', { delay: 20 });
          for (let i = 0; i < n; i += 1) {
            const command = t.start(commands[i % commands.length]);
            await t.pause(pause);
            t.finish(command, `step ${i + 1} output\n`);
            if (i === Math.floor(n / 2)) {
              const rm = t.start('rm -rf dist coverage');
              const key = await t.ask({ title: 'Run this command?', detail: 'rm -rf dist coverage' });
              t.finish(rm, key === 'once' ? '' : null, key === 'once' ? 'completed' : 'declined');
            }
          }
          await t.say('The discount is applied before rounding; rounding once at the end fixes the drift.', { delay: 20 });
        });
        return `chat ${chat.id}: ${n} steps (${pause / 1000} s each) with an approval halfway; open it on the phone and watch the activity group`;
      },
    },
    surface: surfaceScenario(app),
    'huge-output': {
      usage: 'huge-output [kb=600]',
      about: 'a command whose output is larger than one frame',
      run([kb]) {
        const size = toNumber(kb, 600, 4000);
        const chat = chatFor('huge output', 'Run the long test log.');
        const line = (/** @type {number} */ i) => `line ${String(i).padStart(6, '0')} ${'x'.repeat(60)}\n`;
        const output = Array.from({ length: Math.ceil((size * 1024) / 70) }, (_, i) => line(i + 1)).join('');
        void app.enqueue(chat, async (t) => {
          const command = t.start('npm test -- --verbose');
          t.finish(command, output);
          await t.say(`The run printed ${size} KB; the phone shows the start of it. Messages after it still arrive.`);
        });
        return `chat ${chat.id}: a ${size} KB command output (over one frame), then a normal reply`;
      },
    },
    overflow: {
      usage: 'overflow [models=30]',
      about: 'the model menu has that many more models (0 puts it back), so its sheet scrolls and shows "More models"',
      run: ([models]) => {
        const count = models === '0' ? 0 : toNumber(models, 30, 200);
        app.moreModels(count);
        return `the model menu now has ${count} more models; reopen the sheet`;
      },
    },
    ...historyScenarios(app, chatFor, toNumber),
    'answered-elsewhere': {
      usage: 'answered-elsewhere [seconds=20]',
      about: 'an approval the Mac answers while the phone is looking at it',
      run([seconds]) {
        const secs = toNumber(seconds, 20, 600);
        const chat = chatFor('answered on the Mac', 'Delete the build folder.');
        void app.enqueue(chat, async (t) => {
          // only this card: if the phone answered it first, a later card in the chat is not touched
          await t.ask({ title: 'Run this command?', detail: 'rm -rf dist' }, {}, (cardId) =>
            after(secs * 1000, () => app.macAnswers(chat.id, 'once', cardId)),
          );
          await t.say('That was answered on the Mac, so the phone should have shown "Already answered elsewhere".');
        });
        return `chat ${chat.id}: open it now; the card is answered on the Mac after ${secs}s`;
      },
    },
    'child-ask': {
      usage: 'child-ask [parent=dev-seed-readme]',
      about: 'a sub-session of that chat that waits for you: the parent row turns amber and the card shows in the parent chat',
      run([parent = 'dev-seed-readme']) {
        const owner = app.chats.get(parent);
        if (!owner) throw new Error(`No chat ${parent}.`);
        const chat = app.add({
          id: `dev-bench-${app.counter()}`,
          title: '[bench] sub-session asks',
          harness: 'claude',
          at: now(),
          project: owner.project,
          parentId: parent,
        });
        app.row(chat, 'user', 'Show me the pricing doc.');
        void app.enqueue(chat, async (t) => {
          await t.ask({ title: 'Run this command?', detail: 'cat docs/pricing.md' });
          await t.say('Done: the doc says the tax is 8%.');
        });
        return `chat ${chat.id}: a sub-session of ${parent} that waits; answer it on the phone, or run child-answer ${chat.id}`;
      },
    },
    projects: projectsScenario(app, now),
    'silent-row': silentScenario(app, now),
    'side-chat': sideChatScenario(app, now),
    'child-answer': {
      usage: 'child-answer [chat=dev-seed-linked-ask] [key=once]',
      about: "the Mac answers a waiting sub-session's card, so the phone sees the waiting state clear",
      run([chat = 'dev-seed-linked-ask', key = 'once']) {
        if (!app.chats.has(chat)) throw new Error(`No chat ${chat}.`);
        if (!app.macAnswers(chat, key)) throw new Error(`${chat} has no card waiting.`);
        return `${chat}: answered "${key}" on the Mac`;
      },
    },
    plan: {
      usage: 'plan [long]',
      about: 'a plan card (Claude Code plan approval) with the plan text',
      run([size]) {
        const long = size === 'long';
        const text = long ? PLAN.repeat(12) : PLAN;
        const clipped = text.length > PLAN_CLIP;
        const chat = chatFor(long ? 'plan (long, clipped)' : 'plan', 'Plan the fix for the rounding bug.', 'claude');
        void app.enqueue(chat, async (t) => {
          await t.say('Here is my plan. Approve it, or ask for changes.');
          const key = await t.ask(
            {
              title: 'Approve this plan?',
              choices: [
                { key: 'approve', label: 'Approve plan' },
                { key: 'revise', label: 'Ask for changes', deny: true },
              ],
            },
            {
              kind: 'plan',
              plan: { text: clipped ? text.slice(0, PLAN_CLIP) : text, ...(clipped && { clipped: true }), file: 'plans/rounding.md' },
            },
          );
          await t.say(key === 'approve' ? 'Plan approved. Starting on step 1.' : 'Tell me what to change in the plan.');
        });
        return `chat ${chat.id}: a plan card${clipped ? ' (clipped)' : ''}; "Ask for changes" should put the cursor in the message field`;
      },
    },
    cards: {
      usage: 'cards',
      about:
        'one chat each with an approval (a command), a question card and a plan card, all waiting at once: the three cards of a whole-stack device pass',
      run: () => [all.work.run(['4', '1']), all['ask-question'].run([]), all.plan.run([])].join(' | '),
    },
    'chat-link': {
      usage: 'chat-link [target=dev-seed-readme]',
      about: 'a reply with mopilot:chat links (to a chat on the phone, and to one that is not), and a plan card that links to the target',
      run([target = 'dev-seed-readme']) {
        const chat = chatFor('chat links', 'Link me to the other chats.', 'claude');
        void app.enqueue(chat, async (t) => {
          await t.say(`See [the other chat](mopilot:chat/${target}) and [a chat this phone does not have](mopilot:chat/no-such-chat).`);
          await t.ask(
            {
              title: 'Approve this plan?',
              choices: [
                { key: 'approve', label: 'Approve plan' },
                { key: 'revise', label: 'Ask for changes', deny: true },
              ],
            },
            { kind: 'plan', plan: { text: `Plan: first read [the other chat](mopilot:chat/${target}).`, file: 'plans/links.md' } },
          );
        });
        return `chat ${chat.id}: a reply linking to ${target} and to a chat the phone does not have, then a plan card that links to ${target}`;
      },
    },
    'ask-question': {
      usage: 'ask-question',
      about: 'a question card with a single choice, a multiple choice and a free answer; what the phone sends back is said in the chat',
      run() {
        const chat = chatFor('questions', 'Ask me what you need to know before you change the rounding.');
        void app.enqueue(chat, async (t) => {
          await t.say('A few questions before I change anything.');
          await t.ask(
            { title: 'Questions from Claude Code', choices: [{ key: 'answer', label: 'Send answers' }] },
            {
              questions: [
                {
                  id: 'where',
                  header: 'Rounding',
                  question: 'Where should the discount round?',
                  options: [{ label: 'Per item' }, { label: 'At the end' }],
                },
                {
                  id: 'checks',
                  header: 'Checks',
                  question: 'Which checks should run?',
                  multiSelect: true,
                  options: [{ label: 'Unit' }, { label: 'End to end' }],
                },
                { id: 'extra', header: 'Anything else', question: 'Anything else I should know?', isOther: true, options: [] },
              ],
            },
          );
          await t.say(`You answered: ${JSON.stringify(t.values())}`);
        });
        return `chat ${chat.id}: a question card (single, multiple, free text); the answers come back as a message in the chat`;
      },
    },
    'site-approval': {
      usage: 'site-approval [label=shop.example]',
      about: 'a browser approval that says where its action goes ("To: <label>"); label "none" leaves that line out',
      run([label = 'shop.example']) {
        const chat = chatFor('site approval', 'Place the order on the shop.');
        void app.enqueue(chat, async (t) => {
          await t.ask(
            { title: 'Allow Claude Code to act on a high-risk site?', detail: 'Click "Place order"' },
            label === 'none' ? {} : { to: label },
          );
          await t.say('Done.');
        });
        return `chat ${chat.id}: a site approval ${label === 'none' ? 'with no destination line' : `that says To: ${label}`}`;
      },
    },
    ...momoScenarios(need, onOff),
    hosts: {
      usage: 'hosts',
      about: 'the made-up machine old-mini comes online or goes offline (needs --fake-hosts)',
      run: () => need().hosts(),
    },
    agent: {
      usage: 'agent studio|old-mini claude|codex|gemini ready|missing|signin',
      about:
        'one agent on a made-up machine is ready, not installed or signed out, so both refusal wordings can be met (needs --fake-hosts)',
      run: ([machine, agent, state]) => {
        if (!machine || !agent || !state) throw new Error('Usage: agent studio|old-mini claude|codex|gemini ready|missing|signin');
        return need().agent(machine, agent, state);
      },
    },
    direct: {
      usage: 'direct on|off',
      about: 'the Mac\'s switch "Use without your Mac" for every paired phone (needs --real-host)',
      run: ([arg]) => need().direct(onOff(arg, 'direct on|off')),
    },
    'host-card': {
      usage: 'host-card [text]',
      about: 'the real Host raises an approval card with no app attached (needs --real-host; text must contain PERMIT)',
      run: (args) => need().hostCard(args.join(' ') || undefined),
    },
    'host-chat': {
      usage: 'host-chat fake|claude|codex [text]',
      about:
        'the real Host starts a chat on one of its agents (cheapest model, low effort) with no app attached; the phone follows it (needs --real-host)',
      run: ([agent, ...words]) => {
        if (agent !== 'fake' && agent !== 'claude' && agent !== 'codex')
          throw new Error('Say fake, claude or codex: run host-chat fake|claude|codex [text]');
        return need().hostChat(agent, words.join(' ') || 'Reply with only the word OK.');
      },
    },
    'host-status': {
      usage: 'host-status',
      about: "the real Host's agents, installed or absent and signed in or out (needs --real-host)",
      run: () => need().hostStatus(),
    },
    s3: {
      usage: 's3 allow|deny|elsewhere',
      about:
        'assisted run for the person holding the phone: raises one Host card, prints what to ask them to do (lock the phone, act on the notification), then reports what the Host saw (needs --real-host)',
      run: ([step = '']) => need().s3(/** @type {'allow' | 'deny' | 'elsewhere'} */ (step)),
    },
    'host-answer': {
      usage: 'host-answer allow|deny',
      about: "the app answers the real Host's waiting cards, as another client would (needs --real-host)",
      run: ([arg]) => {
        if (arg !== 'allow' && arg !== 'deny') throw new Error('Say allow or deny: run host-answer allow|deny');
        return need().hostAnswer(arg);
      },
    },
    'brain-switch': {
      usage: 'brain-switch on|off',
      about: "the Mac's setting that lets the phone change MoMo's brain",
      run: ([arg]) => need().brainSwitch(onOff(arg, 'brain-switch on|off')),
    },
    sleep: {
      usage: 'sleep [seconds=20]',
      about: 'the Mac sleeps: the phone shows it offline, then it wakes',
      run: ([seconds]) => need().sleep(toNumber(seconds, 20, 3600)),
    },
    unplug: {
      usage: 'unplug [seconds=20]',
      about: 'the Mac drops off the network and reconnects by itself',
      run: ([seconds]) => need().unplug(toNumber(seconds, 20, 3600)),
    },
    'restart-relay': {
      usage: 'restart-relay [seconds=3]',
      about: 'the relay restarts, keeping its mailbox; for a hard restart of the whole host, kill -9 it and start it again',
      run: ([seconds]) => need().restartRelay(toNumber(seconds, 3, 600)),
    },
    revoke: {
      usage: 'revoke [n=1]',
      about: 'the Mac removes a paired phone',
      run: ([n]) => {
        // a typo must not remove the first phone
        const index = n === undefined ? 1 : Number(n);
        if (!Number.isInteger(index) || index < 1) throw new Error('Say which phone: run revoke [n=1]');
        return need().revoke(index);
      },
    },
    gap: {
      usage: 'gap [n=5000] [pairId]',
      about:
        "the Mac's send counter runs n frames ahead of what the phone has seen (every paired phone, or the one named): past 4096 the phone catches up, past 131072 it says to pair again; seen on the next frame",
      run: ([n, pairId]) => need().advanceTx(toNumber(n, 5000, 1_000_000), pairId),
    },
    ...pushScenarios({ need, onOff }),
    chats: {
      usage: 'chats [n=200]',
      about: 'many chats, to test the list',
      run([n]) {
        const wanted = toNumber(n, 200, 5000);
        let made = 0;
        for (let i = 1; i <= wanted; i++) {
          const id = `dev-bulk-${i}`;
          if (app.chats.has(id)) continue;
          const chat = app.add({
            id,
            title: `Bulk chat ${i}: ${['rounding', 'tests', 'release notes', 'refactor', 'review'][i % 5]}`,
            harness: i % 4 === 0 ? 'claude' : 'codex',
            at: now() - i * 60_000,
            // a few projects and none, so the list groups; two are named alike and told apart by id, as two folders named "app" are
            ...BULK_PROJECTS[i % BULK_PROJECTS.length],
          });
          app.row(chat, 'user', `Question ${i}`);
          app.row(chat, 'assistant', `Answer ${i}`);
          made++;
        }
        return `${made} chats added (${wanted} bulk chats in all); pull to refresh the list`;
      },
    },
  };

  return {
    /** The scenarios: usage and what each does. */
    list: () => Object.values(all).map(({ usage, about }) => ({ usage, about })),
    /** Starts one; gives what to look at on the phone (a promise for the ones that wait). @throws for a name that is not one */
    run(/** @type {string} */ name, /** @type {string[]} */ args = []) {
      if (!Object.hasOwn(all, name)) throw new Error(`No scenario "${name}". Try: ${Object.keys(all).join(', ')}`);
      return all[name].run(args);
    },
  };
}
