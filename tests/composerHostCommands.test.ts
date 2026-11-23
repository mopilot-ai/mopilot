// `!cmd` works on this Mac's folder, so a chat on a machine refuses it with one line instead of running in the machine's path here; /init works on the chat's folder wherever it is: it reads the machine's files there (the Host's read-only `fs.read`), writes nothing from here, and sends the same command text (src/components/composer/ComposerCommands.ts, src/lib/initFolder.ts).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $ } from './support/composer-kit.ts';

let onMachine = false;
/** the agent the chat's machine runs it on (`hostAgentOf`) */
let hostAgent = '';
const real = await import('../src/lib/hostChats.ts');
mock.module('../src/lib/hostChats.ts', {
  namedExports: {
    ...real,
    chatFolderHere: async (_id: string | null, cwd: string) => (onMachine ? '' : cwd),
    hostOfChatNow: () => (onMachine ? 'm1' : ''),
  },
});
const realSwitch = await import('../src/store/machineChatSwitch.ts');
mock.module('../src/store/machineChatSwitch.ts', {
  namedExports: { ...realSwitch, hostAgentOf: () => hostAgent, hostRunsClaude: () => hostAgent === 'claude' },
});
// the machine's folder: what it has and what was asked of it (the Host call behind it is src/lib/initFolder.ts's own test, machineInit.test.ts)
const realFolder = await import('../src/lib/initFolder.ts');
mock.module('../src/lib/initFolder.ts', {
  namedExports: {
    ...realFolder,
    machineInitFolder: (id: string, cwd: string) => {
      const path = (file: string) => `${cwd.replace(/\/+$/, '')}/${file}`;
      const text = async (file: string) => {
        read.push([id, path(file)]);
        if (hostFails) throw new Error(hostFails.message);
        const held = there[path(file)];
        return held === undefined ? null : held === 'binary' ? '' : held;
      };
      return { text, exists: async (file: string) => (await text(file)) !== null, path };
    },
  },
});
// the kit's fixture is replaced by reset(): read it through the module, not a copy
const kit = await import('./support/composer-setup.ts');
const { all, last, mountComposer, reset, settle, store } = kit;

/** what the machine has, by path: the text of each file */
let there: Record<string, string> = {};
/** what was read there, as [machine, path] */
const read: string[][] = [];
let hostFails: { message: string } | null = null;

beforeEach(() => {
  reset();
  onMachine = false;
  hostAgent = '';
  there = {};
  read.length = 0;
  hostFails = null;
});
async function sendText(m: any, text: string) {
  await m.type(text);
  if ($('.slash-panel')) await m.key('Escape');
  await m.key('Enter');
  await settle();
}
/** what the composer sent: [chat, text] of the last send */
const sentText = () => last('send')?.slice(1, 3);
/** what touched this Mac's own files */
const mine = () => [...all('readText'), ...all('writeText')];

test('!cmd in a chat on a machine says so and runs nothing here; the same chat on this Mac runs it', async () => {
  kit.fx.caps.shell = 'sage';
  store.set({ harnessOf: { t1: 'claude' }, threads: { t1: { cwd: '/srv/app' } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    onMachine = true;
    await sendText(m, '!git status');
    assert.deepEqual(last('toast'), ['toast', 'Not available for a chat on a machine.', 'error']);
    assert.equal(all('shell').length, 0, 'no shell ran here');
    assert.equal(all('send').length, 0, 'nothing was sent');
    onMachine = false;
    await sendText(m, '!git status');
    assert.deepEqual(last('shell'), ['shell', 'git status', '/srv/app']);
  } finally {
    await m.unmount();
  }
});

test('/init in a Claude Code chat on a machine looks in the machine’s folder and sends the command as typed; this Mac’s files are not touched', async () => {
  (globalThis as any).window.confirm = () => assert.fail('nothing to offer');
  store.set({ harnessOf: { t1: 'claude' }, threads: { t1: { cwd: '/srv/app/' } } });
  there = { '/srv/app/CLAUDE.md': '# Claude' };
  onMachine = true;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await sendText(m, '/init  extra ');
    assert.deepEqual(sentText(), ['t1', '/init extra']);
    assert.deepEqual(read.sort(), [
      ['m1', '/srv/app/AGENTS.md'],
      ['m1', '/srv/app/CLAUDE.md'],
    ]);
    assert.deepEqual(mine(), []);
    assert.equal(last('toast')?.[1] === 'Not available for a chat on a machine.', false);
  } finally {
    await m.unmount();
  }
});

test('/init in a Claude Code chat on a machine with an AGENTS.md: the offer to let Claude read it goes as one more instruction of the command, not as a file written from here', async () => {
  const asked: string[] = [];
  let answer = true;
  (globalThis as any).window.confirm = (t: string) => (asked.push(t), answer);
  store.set({ harnessOf: { t1: 'claude' }, threads: { t1: { cwd: '/srv/app' } } });
  there = { '/srv/app/AGENTS.md': '# Agents', '/srv/app/CLAUDE.md': '# Claude' };
  onMachine = true;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await sendText(m, '/init');
    assert.equal(asked.length, 1);
    assert.deepEqual(sentText(), ['t1', '/init Finally, add this line at the end of CLAUDE.md, once: @AGENTS.md']);
    // declined: the command as typed
    answer = false;
    await sendText(m, '/init');
    assert.deepEqual(sentText(), ['t1', '/init']);
    // a CLAUDE.md that already has the line has nothing to offer
    there['/srv/app/CLAUDE.md'] = '# Claude\n\n@AGENTS.md\n';
    asked.length = 0;
    await sendText(m, '/init');
    assert.equal(asked.length, 0);
    assert.deepEqual(sentText(), ['t1', '/init']);
    // nothing of this Mac's is read or written, before or after the command's turn
    assert.deepEqual(mine(), []);
  } finally {
    await m.unmount();
  }
});

test('/init in a Codex chat on a machine asks the machine’s folder what is there, as it does here: it asks before replacing AGENTS.md and offers to read CLAUDE.md', async () => {
  const asked: string[] = [];
  const answers: boolean[] = [];
  (globalThis as any).window.confirm = (t: string) => (asked.push(t), answers.shift() ?? false);
  store.set({ harnessOf: { t1: 'codex' }, threads: { t1: { cwd: '/srv/app' } } });
  onMachine = true;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await sendText(m, '/init');
    assert.equal(asked.length, 0);
    assert.match(sentText()![1], /^Analyze this codebase and create an AGENTS\.md/);
    // AGENTS.md is there: Cancel keeps it and sends nothing
    there = { '/srv/app/AGENTS.md': '# Agents' };
    const sent = all('send').length;
    await sendText(m, '/init');
    assert.equal(asked.length, 1);
    assert.equal(all('send').length, sent);
    // OK replaces it; CLAUDE.md is there too and its offer is accepted, as a line of the prompt
    there['/srv/app/CLAUDE.md'] = '# Claude';
    answers.push(true, true);
    await sendText(m, '/init');
    assert.match(sentText()![1], /Finally, add this line at the end of AGENTS\.md, once: Also follow the instructions in CLAUDE\.md\./);
    assert.deepEqual(mine(), []);
  } finally {
    await m.unmount();
  }
});

test('/init in a chat that a machine runs on Claude Code, though it is drawn as another agent, is Claude Code’s own command', async () => {
  (globalThis as any).window.confirm = () => true;
  store.set({ harnessOf: { t1: 'codex' }, threads: { t1: { cwd: '/srv/app' } } });
  there = { '/srv/app/AGENTS.md': '# Agents' };
  onMachine = true;
  hostAgent = 'claude';
  const m = await mountComposer({ threadId: 't1' });
  try {
    await sendText(m, '/init');
    assert.deepEqual(sentText(), ['t1', '/init Finally, add this line at the end of CLAUDE.md, once: @AGENTS.md']);
    hostAgent = 'codex';
    await sendText(m, '/init');
    assert.match(sentText()![1], /^Analyze this codebase/);
  } finally {
    await m.unmount();
  }
});

test('/init when the machine does not answer sends nothing and says why; a folder or a file that is not text is a file that is there', async () => {
  (globalThis as any).window.confirm = () => assert.fail('nothing to ask');
  store.set({ harnessOf: { t1: 'claude' }, threads: { t1: { cwd: '/srv/app' } } });
  onMachine = true;
  const m = await mountComposer({ threadId: 't1' });
  try {
    hostFails = { message: 'The machine took too long to read that.' };
    await sendText(m, '/init');
    assert.deepEqual(last('toast'), ['toast', 'The machine took too long to read that.', 'error']);
    assert.equal(all('send').length, 0);
    // a file the machine reports as not text is there, with nothing to read: no pointer is found in it, so the offer stands
    hostFails = null;
    there = { '/srv/app/AGENTS.md': 'binary', '/srv/app/CLAUDE.md': 'binary' };
    (globalThis as any).window.confirm = () => false;
    await sendText(m, '/init');
    assert.deepEqual(sentText(), ['t1', '/init']);
  } finally {
    await m.unmount();
  }
});
