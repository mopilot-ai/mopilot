// DEV ONLY: the fake app's fixed data: the harnesses and menus it offers, its seeded chats and the raw Codex events its scripted turns hand the item feed.
/** What a read of a chat that is not here fails with (the service answers it as 'gone'). */
import { familyMessageText, wakeText } from '../../shared/sideSessions.mjs';
import { peerPrompt } from '../../shared/peerPrompt.mjs';
import { gridPng } from './fakeImages.mjs';

export const GONE = "That chat isn't in MoPilot.";
export const CHOICES = [
  { key: 'once', label: 'Allow once' },
  { key: 'deny', label: 'Deny', deny: true },
];
/** The / menu of a Codex chat (skills carried beside the text) and of any other chat (commands and skills typed as /name). */
export const COMMANDS = {
  skill: [
    { name: 'pdf', description: 'Read, merge and fill PDF files', hint: '', kind: 'skill', as: 'skill' },
    { name: 'frontend-design', description: 'Design a page that does not look generic', hint: '', kind: 'skill', as: 'skill' },
  ],
  text: [
    { name: 'review', description: 'Review the changes in this chat', hint: '[focus]', kind: 'command', as: 'text' },
    { name: 'compact', description: 'Summarize the conversation to free up space', hint: '', kind: 'command', as: 'text' },
    { name: 'pdf', description: 'Read, merge and fill PDF files', hint: '', kind: 'skill', as: 'text' },
  ],
};
export const HARNESSES = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
];
/** Every agent with its state, a signed-out one a chat cannot move to included, so a phone has each case to draw. */
export const HARNESS_STATES = [
  ...HARNESSES.map((h) => ({ ...h, kind: 'builtin', state: 'ready', reason: null, canSwitch: true, switchReason: null })),
  {
    id: 'acp:gemini',
    label: 'Gemini',
    kind: 'acp',
    state: 'signin',
    reason: null,
    canSwitch: false,
    switchReason: "Gemini can't take a chat now.",
  },
];
export const OPTIONS = {
  models: [
    {
      id: 'dev-fast',
      label: 'Dev Fast',
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
      defaultEffort: 'low',
    },
    { id: 'dev-deep', label: 'Dev Deep', efforts: [], defaultEffort: null },
  ],
  model: 'dev-fast',
  effort: 'low',
  permission: {
    value: 'default',
    rows: [
      { id: 'default', label: 'Default permissions', detail: 'Ask before running commands' },
      { id: 'auto-review', label: 'Auto-review', detail: 'A reviewer approves routine commands' },
    ],
  },
  accounts: [],
};

/** The raw Codex events the controller would hand the item feed (the same shapes tests/mobileStackChat.test.ts feeds it). */
export const codex = {
  turn: (/** @type {string} */ id, /** @type {string} */ method, /** @type {string} */ status, /** @type {string} */ error = '') => ({
    method,
    params: { threadId: id, turn: { id: 't', status, ...(error && { error: { message: error } }) } },
  }),
  message: (/** @type {string} */ id, /** @type {string} */ method, /** @type {string} */ itemId, /** @type {string} */ text) => ({
    method,
    params: {
      threadId: id,
      turnId: 't',
      item: { type: 'agentMessage', id: itemId, text, phase: null, memoryCitation: null, delivery: null },
    },
  }),
  /** What the person typed, as the controller streams it into the item feed when a send is accepted. */
  user: (
    /** @type {string} */ id,
    /** @type {string} */ itemId,
    /** @type {string} */ text,
    /** @type {number} */ images = 0,
    /** @type {string | undefined} */ clientId = undefined,
  ) => ({
    method: 'item/completed',
    params: {
      threadId: id,
      turnId: 't',
      // a message with pictures carries a part for each, as the Mac's item does, so the phone counts them and does not show the message twice
      item: {
        type: 'userMessage',
        id: itemId,
        // the phone's own send, so it is not shown twice (the Mac names the message by the id it derives from the send)
        ...(clientId ? { clientId } : {}),
        content: [...Array.from({ length: images }, () => ({ type: 'image' })), { type: 'text', text, text_elements: [] }],
      },
    },
  }),
  delta: (/** @type {string} */ id, /** @type {string} */ itemId, /** @type {string} */ delta) => ({
    method: 'item/agentMessage/delta',
    params: { threadId: id, turnId: 't', itemId, delta },
  }),
  command: (
    /** @type {string} */ id,
    /** @type {string} */ itemId,
    /** @type {string} */ command,
    /** @type {string} */ status,
    /** @type {string | null} */ output,
  ) => ({
    method: status === 'inProgress' ? 'item/started' : 'item/completed',
    params: {
      threadId: id,
      turnId: 't',
      item: {
        type: 'commandExecution',
        id: itemId,
        command,
        cwd: '',
        processId: null,
        source: 'agent',
        status,
        commandActions: [],
        aggregatedOutput: output,
        exitCode: status === 'completed' ? 0 : null,
        durationMs: null,
        pluginId: null,
        scriptPath: null,
      },
    },
  }),
};

/** A reply of the owner's (issue #4644): a table right after a paragraph line, bold runs next to CJK punctuation and characters, bold inside cells, and a struck-through run. */
export const TABLE_REPLY = [
  '正面宽 21.5″ 对上 LMC1575 (21.41″)。**LG 官方的 30″ 嵌入框 MK2030NST 只配 2.0 立方英尺的 LMC2075，这台没有配套的嵌入框。**清单里的微波炉卡片改成了三个办法：',
  '| 办法 | 花费 | 说明 |',
  '|---|---|---|',
  '| **推荐**：换 LG LMC2075ST + MK2030NST 嵌入框 | 约 $259 + $259 ≈ **$520** | 外观和现在这台一样，官方配套。 |',
  '| Bosch 500 HMB50152UC（原生嵌入式） | **$999** | 不用嵌入框，最整齐 |',
  '',
  '旧的做法 ~~直接换整台~~ 已经划掉。',
].join('\n');

/** A long history's assistant reply, richer than a line: prose, a code block, a table and a list in turn (`run long-history N rich`). @param {number} n @param {number} of */
export const richReply = (n, of) =>
  [
    `Message ${n} of ${of}: the total multiplied before rounding, so a 10% discount drifts by a cent.`,
    `Message ${n} of ${of}:\n\n\`\`\`ts\nexport const total = (items: number[]) => Math.round(items.reduce((a, b) => a + b, 0) * 100) / 100;\n\`\`\`\n\nRound once, at the end.`,
    `Message ${n} of ${of}:\n\n| item | before | after |\n|---|---|---|\n| 3 × 9.99 | 26.97 | 26.98 |\n| 10% off | 2.70 | 2.70 |\n\nThe second row did not change.`,
    `Message ${n} of ${of}, in short:\n\n- rounded once at the end\n- added a test for the discount case\n- left the tax path alone`,
  ][n % 4];

/** The odd shapes a reply can have for a native text view (#5368): blocks with no words in them (an empty heading, list item, link or table cell), a URL straight against CJK text, soft and hard breaks, a code-only line, a list item with a second paragraph, a task list. */
export const EDGE_REPLIES = [
  '## Empty heading below\n\n#\n\nThen words.',
  'An empty list item:\n\n- one\n-\n- three',
  'An empty link: [](https://example.com) and a link [with words](https://example.com).',
  '| a | b |\n|---|---|\n| | x |\n| y | |',
  '| | b |\n|---|---|\n| 1 | 2 |',
  '`★ Insight ─────────────────────────────────────`\n- first line\n  second line of the same item\n`─────────────────────────────────────────────────`',
  '- first\n\n  a second paragraph in the item\n\n  `just code`',
  '- [x] done\n- [ ] open\n\nsoft\nbreak and a hard  \nbreak',
  'https://example.com/a\u4e2d\u6587\u8bf4\u660e \u4e4b\u540e\u7684\u8bdd',
];
export const edgeReply = (n) => EDGE_REPLIES[n % EDGE_REPLIES.length];
/** Your own message as the owner met it: a URL straight against CJK text, with no space. */
export const EDGE_USER = 'https://example.com/a\u4e2d\u6587\u8bf4\u660e\u5728\u8fd9\u91cc';

/** A long finished Claude Code style reply (#5351): an insight line drawn with rules, a heading, bullets, a thematic break and a link; with `blocks` also a fenced code block and a table, which are sideways scrollers on the phone. */
export const insightReply = (n, of, blocks) =>
  [
    `\`★ Insight ─────────────────────────────────────\`\n- Message ${n} of ${of}: round once, at the end, not per item.\n- A discount multiplies before rounding, so it drifts by a cent.\n\`─────────────────────────────────────────────────\``,
    `## Round the total once\n\nThe total multiplies before it rounds, so a 10% discount on 3 × 9.99 drifts. Every step below keeps the cents until the last line, and the diff stays small: one function and one test, with nothing else touched in the checkout path. See [the pricing notes](https://example.com/pricing) for the rule this follows.\n\n- keep cents as integers until the last step\n- round once, at the end\n- cover the drift case in a test`,
    ...(blocks
      ? [
          '```ts\nexport const total = (items: number[], discount = 0) =>\n  Math.round(items.reduce((a, b) => a + b, 0) * (1 - discount) * 100) / 100; // rounds once, at the end, so a long line scrolls sideways\n```',
          '| item | before | after | note |\n|---|---|---|---|\n| 3 × 9.99 | 26.97 | 26.98 | the cent that drifted |\n| 10% off | 2.70 | 2.70 | unchanged |',
        ]
      : ['Nothing here needs a code block: the change is one line, and its test says the rest.']),
    `---\n\nThat is message ${n} of ${of}. The tests pass; the diff touches src/price.ts and tests/price.test.ts only.`,
  ].join('\n\n');

/** One reply with every kind of link the phone should open or offer a menu for (#5358): a bare URL, a Markdown link, a link that wraps over two lines, and a link in a list item. */
export const LINKS_REPLY = [
  'A bare URL in a paragraph: https://example.com/a-bare-url and then more words after it.',
  'A Markdown link: [Example docs](https://example.com/docs) in a sentence.',
  'A long link that wraps over two lines: [the full write-up of how the checkout total is rounded once at the end of the calculation, with every case](https://example.com/docs/checkout/rounding/the-complete-write-up).',
  '- a link in a list item: [list link](https://example.com/list)\n- a bare URL in a list item: https://example.com/list-bare',
].join('\n\n');

/** Where the seeded project's folder is, so a second project of its name can be told apart by its parent folders. */
export const DEV_REPO = '/Users/dev/code/dev-repo';

export const SEEDS = [
  {
    id: 'dev-seed-login',
    title: 'Fix the discount rounding in checkout',
    harness: 'codex',
    ago: 8 * 60_000,
    rows: [
      ['user', 'The checkout total is off by a cent when a discount applies. Can you look at src/price.ts?'],
      ['step', 'Read src/price.ts'],
      [
        'assistant',
        'The total multiplies before rounding, so a 10% discount on 3 × 9.99 drifts. I rounded once at the end and added a `discount` parameter.',
      ],
      ['step', 'Edited src/price.ts'],
      ['assistant', 'Done. `git diff` shows the change; the test still passes.'],
    ],
  },
  {
    id: 'dev-seed-readme',
    title: 'Summarize the README for the release notes',
    harness: 'claude',
    ago: 3 * 3_600_000,
    // a project and a login, as the Mac names them where the agent has several accounts
    project: 'dev-repo',
    projectPath: DEV_REPO,
    account: 'work@mopilot.example',
    rows: [
      ['user', 'Summarize README.md in two sentences for the release notes.'],
      [
        'assistant',
        'Shop is a tiny price calculator used by the checkout page. It exposes `total(price, qty)` and applies a fixed 8% tax.',
      ],
    ],
  },
  {
    id: 'dev-seed-pictures',
    title: '[test] Pictures',
    harness: 'codex',
    ago: 6 * 3_600_000,
    rows: [
      ['user', 'A tall screenshot.', { images: [gridPng(600, 2000, [200, 120, 60])] }],
      ['user', 'A wide picture.', { images: [gridPng(2000, 500, [60, 120, 200])] }],
      ['user', 'A square one.', { images: [gridPng(900, 900, [80, 170, 90])] }],
      ['assistant', 'Three pictures to zoom into.'],
    ],
  },
  {
    id: 'dev-seed-waiting',
    title: 'Clean up the generated files',
    harness: 'codex',
    ago: 60_000,
    waiting: { title: 'Run this command?', detail: 'rm -rf dist coverage' },
    rows: [
      ['user', 'Remove the build output before I commit.'],
      ['assistant', 'I need to delete `dist` and `coverage`. This waits for your approval.'],
    ],
  },
  // linked sessions the README chat started, which the phone folds under it as the Mac's sidebar nests them
  {
    id: 'dev-seed-linked-notes',
    title: 'Draft the changelog entry',
    harness: 'codex',
    ago: 4 * 3_600_000,
    project: 'dev-repo',
    projectPath: DEV_REPO,
    parentId: 'dev-seed-readme',
    ended: 'finished',
    rows: [
      ['user', 'Draft a one-line changelog entry from the README summary.'],
      ['assistant', 'Added: `total(price, qty)` now applies the fixed 8% tax once.'],
    ],
  },
  {
    id: 'dev-seed-linked-check',
    title: 'Check the tax rate against the docs',
    harness: 'claude',
    ago: 5 * 3_600_000,
    project: 'dev-repo',
    projectPath: DEV_REPO,
    parentId: 'dev-seed-readme',
    ended: 'failed',
    rows: [
      ['user', 'Confirm the README tax rate matches docs/pricing.md.'],
      ['assistant', 'docs/pricing.md is missing, so the rate could not be checked.'],
    ],
  },
  // a sub-session that waits for the person: its parent row turns amber and its card shows in the parent chat
  {
    id: 'dev-seed-linked-ask',
    title: 'Edit the pricing doc',
    harness: 'claude',
    ago: 3 * 60_000,
    project: 'dev-repo',
    projectPath: DEV_REPO,
    parentId: 'dev-seed-readme',
    waiting: { title: 'Edit this file?', detail: 'docs/pricing.md' },
    rows: [
      ['user', 'Add the 8% tax line to docs/pricing.md.'],
      ['assistant', 'I need your approval to edit docs/pricing.md.'],
    ],
  },
  // every kind of message MoPilot itself writes into a chat, built by the real envelope builders: each must show as a one-line card
  {
    id: 'dev-seed-authored',
    title: 'Messages MoPilot wrote',
    harness: 'codex',
    ago: 2 * 60_000,
    rows: [
      ['user', 'Start a session to fix the build and tell me when it is done.'],
      [
        'user',
        familyMessageText({
          fromName: 'fix-build',
          fromId: 'dev-seed-readme',
          relation: 'child',
          body: 'The build is green again; I pinned the toolchain.',
        }),
      ],
      [
        'user',
        familyMessageText({ fromName: 'main-chat', fromId: 'dev-seed-login', relation: 'parent', body: 'Please also run the linter.' }),
      ],
      [
        'user',
        peerPrompt({
          id: 'm1',
          sourceChatId: 'dev-seed-login',
          sourceTitle: 'Checkout fix',
          replyTo: null,
          body: 'Can you review src/price.ts?',
          reply: 'awaiting',
        }),
      ],
      [
        'user',
        peerPrompt({
          id: 'm2',
          sourceChatId: 'dev-seed-login',
          sourceTitle: 'Checkout fix',
          replyTo: 'm1',
          body: 'Looks good to me.',
          reply: 'none',
        }),
      ],
      ['user', wakeText({ notes: ['fix-build finished a turn.'], roster: '', waiting: [] })],
      [
        'user',
        '<task-notification>\n<task-id>bg</task-id>\n<summary>Background command "npm test" completed</summary>\n</task-notification>',
      ],
      ['user', "The user hasn't heard from you in a while \u2014 say in a few words what you're doing, then continue."],
      ['assistant', 'The linter is clean. Everything is done.'],
    ],
  },
];

/** The chats the Mac starts on a schedule, as `scheduled.list` gives them: when each runs next (none: paused or finished), and, for a Host's, where. */
export const SCHEDULED = [
  { id: 's-standup', name: 'Daily standup digest', in: 25 * 60_000 },
  { id: 's-deps', name: 'Weekly dependency check', in: 26 * 3_600_000 },
  { id: 's-backup', name: 'Nightly backup of the notes folder', in: 5 * 3_600_000, hostId: 'ssh:studio', firesWhileMacAway: true },
  // a machine the Mac no longer lists: the phone cannot name it, so its row names no machine
  { id: 's-retired', name: 'Quarterly reports export', in: 2 * 3_600_000, hostId: 'ssh:retired', firesWhileMacAway: false },
  { id: 's-paused', name: 'Monthly invoice export', in: null },
];

/** The logins the dev host offers on each harness, so a phone has every state to draw: two signed in (one in use), one signed out, one at its limit. */
const STAND_IN_LOGINS = [
  { id: 'work', label: 'Work', loggedIn: true, active: true, limited: false },
  { id: 'personal', label: 'Personal', loggedIn: true, active: false, limited: false },
  { id: 'old', label: 'Old', loggedIn: false, active: false, limited: false },
  { id: 'spare', label: 'Spare', loggedIn: true, active: false, limited: true },
];

/** Simulated local subscription windows for the dev host; never read the user's real accounts. */
export function fakeUsage(at) {
  const window = (label, usedPercent, hours) => ({ label, usedPercent, resetsAt: at / 1000 + hours * 3600, at, stale: false });
  return {
    scope: 'local',
    accounts: ['claude', 'codex'].flatMap((harness) =>
      STAND_IN_LOGINS.map((l) => ({
        harness,
        account: l.id,
        label: l.label,
        active: l.active,
        state: l.loggedIn ? 'available' : 'signin',
        windows: !l.loggedIn
          ? []
          : l.limited
            ? [window('5h', 100, 2), window('Weekly', 92, 60)]
            : [window('5h', l.active ? 42 : 71, 1), window('Weekly', 10, 24)],
      })),
    ),
  };
}

/** The accounts calls: two Claude Code logins (one signed out) and a Codex one, so a phone's accounts view has every state to draw; auto-switch is kept per harness. @param {(line: string) => void} log */
export function fakeAccounts(log) {
  const autoSwitch = { claude: true, codex: true };
  /** @type {Map<string, string | null>} */
  const pins = new Map();
  return {
    harnessStates: async () => HARNESS_STATES,
    setChatAccount: (/** @type {{ chatId: string, account: string | null }} */ p) => {
      log(`app: ${p.chatId} on ${p.account ?? 'the agent’s own choice'}`);
      pins.set(p.chatId, p.account);
      return { chatId: p.chatId, account: p.account, pinned: p.account !== null };
    },
    /** What a menu says about logins, for the phone's Account row: an open chat reports its pin and the one serving it, a new chat only the list (stand-in logins, never real ones). */
    menuOf: (/** @type {{ chatId?: string }} */ target) => {
      const logins = STAND_IN_LOGINS.map(({ id, label, loggedIn, limited }) => ({ id, label, loggedIn, limited }));
      if (!target.chatId) return { accounts: logins };
      const id = pins.get(target.chatId) ?? null;
      return {
        perChat: true,
        accounts: logins,
        account: { id, pinned: id !== null, serving: STAND_IN_LOGINS.find((l) => l.id === (id ?? 'work'))?.label ?? null },
      };
    },
    accounts: () => ({
      scope: 'local',
      harnesses: [
        { harness: 'claude', autoSwitch: autoSwitch.claude, pool: 'single' },
        { harness: 'codex', autoSwitch: autoSwitch.codex, pool: 'spread' },
      ],
      accounts: ['claude', 'codex'].flatMap((harness) =>
        STAND_IN_LOGINS.map((l) => ({
          harness,
          account: l.id,
          label: l.label,
          status: l.loggedIn ? 'ok' : 'signedOut',
          billing: 'subscription',
          active: l.active,
          limited: l.limited,
        })),
      ),
    }),
    setAutoSwitch: (/** @type {{ harness: 'claude' | 'codex', on: boolean }} */ p) => {
      autoSwitch[p.harness] = p.on;
      log(`app: auto-switch ${p.harness} ${p.on ? 'on' : 'off'}`);
      return { harness: p.harness, autoSwitch: p.on };
    },
  };
}

/**
 * The menus a phone reads for a chat or a new chat: what was chosen for the chat (a model's own default effort when none was), as the real app's, and the logins it may pick.
 * @param {{ chatId?: string }} target @param {{ model?: string, effort?: string | null, permission?: string }} mine @param {(target: { chatId?: string }) => object} menuOf @param {object[]} [extra] more models after the bench's two (`run overflow`) @returns {any}
 */
export function optionsOf(target, mine, menuOf, extra = []) {
  const model = mine.model ?? OPTIONS.model;
  const known = OPTIONS.models.find((m) => m.id === model);
  const effort = mine.effort ?? (mine.model ? (known?.defaultEffort ?? null) : OPTIONS.effort);
  const permission = { ...OPTIONS.permission, value: mine.permission ?? OPTIONS.permission.value };
  return { ...OPTIONS, models: [...OPTIONS.models, ...extra], ...menuOf(target), model, effort, permission };
}
