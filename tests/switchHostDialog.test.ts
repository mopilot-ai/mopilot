// The Switch host dialog: which machines it offers and why a row is off, the folder field and what it remembers, every refusal's copy with the form and the composer's draft intact, the lost-host confirmation, and Browse.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import './support/dom.ts';
import { $, $$, click, key, mockTsx, mount } from './support/composer-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { lastDirectory, refusalCopy, targetsFor } from '../src/lib/hostSwitch.ts';
import type { SwitchMachine } from '../src/lib/hostSwitch.ts';

// the folder picker has its own tests; here it is a stand-in that picks or closes
const picked: string[] = [];
mockTsx(new URL('../src/components/composer/HostFolderPicker.tsx', import.meta.url), {
  HostFolderPicker: ({ hostId, name, onPick, onClose }: any) => {
    picked.push(`${hostId}:${name}`);
    return createElement(
      'div',
      { role: 'dialog', 'aria-label': 'picker' },
      createElement('button', { id: 'pick', onClick: () => onPick('/srv/picked') }, 'pick'),
      createElement('button', { id: 'shut', onClick: onClose }, 'shut'),
    );
  },
});
const { SwitchHostDialog } = await import('../src/components/composer/SwitchHostDialog.tsx');

const FLEET: SwitchMachine[] = [
  { id: 'local', name: 'This Mac', status: 'online', note: 'Browser, Computer use' },
  { id: 'box', name: 'build-box', status: 'offline', note: 'Offline' },
  { id: 'lab', name: 'lab', status: 'attention', note: 'Needs login' },
  { id: 'dev', name: 'dev-vm', status: 'online', note: 'SSH · Codex' },
  { id: 'gpu', name: 'gpu-rig', status: 'online', note: 'SSH · Claude' },
];

type Props = Record<string, any>;
const calls: any[] = [];
let closed = 0;
const base = (over: Props = {}): Props => ({
  chatId: 'c1',
  project: '/work/app',
  ownerId: 'local',
  ownerLost: false,
  machines: FLEET,
  turnRunning: false,
  onContinue: async (req: unknown) => void calls.push(req),
  onClose: () => void closed++,
  ...over,
});
beforeEach(() => {
  calls.length = 0;
  closed = 0;
  localStorage.clear();
});

const rows = () => $$('[role=radio]');
const dirInput = () => $('input[aria-label="Folder on the host"]') as HTMLInputElement;
const submit = () => $$('.acct-dialog-actions button').find((b) => /Switch host|Switching|Try again/.test(b.textContent!))!;
const hint = () => $('.acct-dialog-hint')?.textContent ?? null;
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const enter = (el: Element, init: Record<string, any> = {}) => key(el, 'Enter', init);
const open = async (over: Props = {}) => mount(createElement(SwitchHostDialog, base(over) as any));
/** a refusal as main sends it: a message and the Host's code */
const refusal = (code: string, message = 'raw message') => Object.assign(new Error(message), { code });

test('offers every machine but the owner; an off row says why and cannot be picked; the first ready one is chosen', async () => {
  const m = await open();
  try {
    assert.equal($('[role=dialog]').getAttribute('aria-modal'), 'true');
    assert.equal($('.dialog-head').textContent, 'Switch host');
    assert.deepEqual(
      rows().map((r) => [$('.switch-host-name', r).textContent, $('.switch-host-note', r).textContent, (r as HTMLButtonElement).disabled]),
      [
        ['build-box', 'Offline', true],
        ['lab', 'Needs login', true],
        ['dev-vm', 'SSH · Codex', false],
        ['gpu-rig', 'SSH · Claude', false],
      ],
    );
    assert.deepEqual(
      rows().map((r) => r.getAttribute('aria-checked')),
      ['false', 'false', 'true', 'false'],
    );
    assert.equal(rows()[0].getAttribute('title'), 'Offline');
    assert.equal(rows()[2].getAttribute('title'), null);
    assert.equal(hint(), 'Choose a folder on dev-vm.');
    assert.equal(dirInput().placeholder, 'Folder on dev-vm');
    assert.equal((submit() as HTMLButtonElement).disabled, true);
  } finally {
    await m.unmount();
  }
});

test('a folder is required; Switch host sends the chosen machine and folder, remembers it per project and machine, and closes', async () => {
  const m = await open();
  try {
    await type(dirInput(), '  ~/src/app  ');
    assert.equal(hint(), null);
    await click(submit());
    assert.deepEqual(calls, [{ chatId: 'c1', targetHostId: 'dev', cwd: '~/src/app', lostHostConfirmed: false }]);
    assert.equal(closed, 1);
    assert.equal(lastDirectory('/work/app', 'dev'), '~/src/app');
    assert.equal(lastDirectory('/work/app', 'gpu'), '', 'another machine has its own');
    assert.equal(lastDirectory('/other', 'dev'), '', 'another project has its own');
  } finally {
    await m.unmount();
  }
  const again = await open();
  try {
    assert.equal(dirInput().value, '~/src/app', 'the next switch starts at the last folder');
    await click(rows()[3]);
    assert.equal(rows()[3].getAttribute('aria-checked'), 'true');
    assert.equal(dirInput().value, '', 'the other machine starts empty');
    await type(dirInput(), '/srv/app');
    await click(rows()[2]);
    assert.equal(dirInput().value, '~/src/app', 'each machine keeps its own typed folder');
    await click(rows()[0]);
    assert.equal(rows()[2].getAttribute('aria-checked'), 'true', 'a row that is off cannot be picked');
  } finally {
    await again.unmount();
  }
});

test('keyboard focus starts in the dialog (so Escape reaches it), on the folder field when there is one', async () => {
  const m = await open();
  try {
    assert.equal(document.activeElement, dirInput());
  } finally {
    await m.unmount();
  }
  const bare = await open({ machines: FLEET.slice(0, 3) });
  try {
    assert.equal(document.activeElement, $('[role=dialog]'), 'no field: the dialog itself');
  } finally {
    await bare.unmount();
  }
});

test('Enter in the folder field switches only when a folder is typed', async () => {
  const m = await open();
  try {
    await enter(dirInput());
    await key(dirInput(), 'a');
    await enter(dirInput(), { isComposing: true });
    assert.equal(calls.length, 0, 'no folder, a plain key and a composing Enter send nothing');
    await type(dirInput(), '/srv/app');
    await enter(dirInput());
    assert.equal(calls.length, 1);
    assert.equal(closed, 1);
  } finally {
    await m.unmount();
  }
});

const CODES: [string, string][] = [
  // by the fact that holds, with the chat's agent named (the test opens the dialog for a Codex chat)
  ['agent_missing', "Codex isn't installed on dev-vm."],
  ['agent_signed_out', 'Sign in to Codex on dev-vm.'],
  ['agent_login_refused', "Codex's login on dev-vm is refused. Sign in again."],
  ['harness_not_configured', 'dev-vm is too old to take this chat. Update it.'],
  ['directory_missing', "That folder doesn't exist on dev-vm."],
  ['continue_in_flight', 'This chat is already being switched.'],
  ['turn_running', 'The chat is busy. Wait for it to finish, or stop it, then try again.'],
  ['host_unreachable', "dev-vm isn't reachable. Check it's online, then try again."],
  ['target_offline', "dev-vm isn't reachable. Check it's online, then try again."],
  ['commit_unsettled', "dev-vm didn't confirm the switch. The chat stays where it was; try again."],
  ['chat_released', 'This chat moved to another host meanwhile.'],
  ['owner_changed', 'This chat moved to another host meanwhile.'],
  // main names what is unsupported (this Mac cannot clone, the agent cannot move): its sentence is shown, not a generic one
  ['unsupported', 'Raw message.'],
  ['outside_roots', 'That folder is outside what dev-vm shares.'],
  ['prepare_unsettled', "The switch didn't start on dev-vm. Try again."],
  ['not_prepared', "The switch didn't start on dev-vm. Try again."],
  ['same_host', 'This chat already runs there.'],
  ['continue_cancelled', 'The switch was cancelled.'],
  ['target_dirty', 'The folder on dev-vm has changes of its own. Clean it up, or continue without the changes.'],
  ['carry_other_branch', 'The folder on dev-vm is on another branch. Switch it first, or continue without the changes.'],
  ['carry_diverged', 'The folder on dev-vm has other commits. Update it, or continue without the changes.'],
  ['carry_conflict', "The changes don't apply to the folder on dev-vm. Try again, or continue without the changes."],
  ['carry_no_repository', "The folder on dev-vm isn't a repository. Pick the repository's folder, or continue without the changes."],
  ['carry_mismatch', "The changes that reached dev-vm aren't the ones sent. Try again, or continue without the changes."],
  ['carry_push_failed', "The changes couldn't be sent. Try again, or continue without the changes."],
  ['carry_fetch_failed', "dev-vm couldn't fetch the changes. Try again, or continue without the changes."],
  ['carry_unconfirmed', 'Confirm the new files first, or continue without the changes.'],
  ['nothing_to_carry', "The changes couldn't be gathered. Check that the folder has a commit and a remote."],
  ['no_remote', "This repository has no remote, so its code can't be cloned."],
  ['unknown_source', "This chat's folder isn't a repository."],
  // the Host refusals the dialog has no copy of its own for are worded by the one table every machine chat reads
  ['session_journal_deleted', 'This chat was deleted from dev-vm.'],
  ['chat_unknown', 'dev-vm has no such chat.'],
  ['feature_missing', 'Raw message.'],
  ['policy_refused', 'Raw message.'],
  ['directory_missing', "That folder doesn't exist on dev-vm."],
  ['outside_roots', 'That folder is outside what dev-vm shares.'],
  ['stale_epoch', 'This chat moved to another machine.'],
  ['constructor', 'Raw message.'],
];

test('every refusal shows its copy in place; the form, the folder and the composer draft stay as they were', async () => {
  for (const [code, copy] of CODES) {
    localStorage.clear();
    let attempt = 0;
    const draft = document.createElement('textarea');
    draft.value = 'half-written prompt';
    document.body.append(draft);
    const m = await open({
      agent: 'codex',
      onContinue: async (req: unknown) => {
        calls.push(req);
        if (attempt++ === 0) throw refusal(code);
      },
    });
    try {
      await type(dirInput(), '/srv/app');
      await click(submit());
      assert.equal($('[role=alert]').textContent, copy, code);
      assert.equal(refusalCopy(code, 'dev-vm', 'Raw message.', 'codex'), copy, code);
      assert.equal(closed, 0, 'a refusal leaves the dialog open');
      assert.equal(dirInput().value, '/srv/app');
      assert.equal(rows()[2].getAttribute('aria-checked'), 'true');
      assert.equal(submit().textContent, /^(host_unr|target_off)/.test(code) ? 'Try again' : 'Switch host', 'the button is back');
      assert.equal(draft.value, 'half-written prompt', 'the composer draft is untouched');
      assert.equal(lastDirectory('/work/app', 'dev'), '', 'a failed switch remembers nothing');
      await click(submit());
      assert.equal($('[role=alert]'), null, 'trying again clears the reason');
      assert.equal(closed, 1);
    } finally {
      await m.unmount();
      draft.remove();
      closed = 0;
      calls.length = 0;
    }
  }
  assert.equal(refusalCopy(undefined, 'dev-vm'), "Couldn't switch host.", 'no message, no code');
  // a dialog that was not told the chat's agent still says the fact
  assert.equal(refusalCopy('agent_missing', 'dev-vm'), "The agent isn't installed on dev-vm.");
});

/** A machine as its row reports it: the agents with what each is ready for and the line that says why not. */
const box = (agents: object[], over: object = {}): SwitchMachine => ({
  id: 'box',
  name: 'build-box',
  status: 'online',
  note: 'SSH',
  agents: agents as any,
  ...over,
});
const claude = (state: 'ready' | 'signin' | 'missing', reason = '') => ({ id: 'claude', label: 'Claude Code', state, reason });
const codex = (state: 'ready' | 'signin' | 'missing', reason = '') => ({ id: 'codex', label: 'Codex', state, reason });
const gemini = (state: 'ready' | 'signin' | 'missing', reason = '') => ({ id: 'gemini', label: 'Gemini CLI', state, reason });

test("a machine that cannot take the chat's agent says so on its row before anything is pressed: Claude Code, Codex and an ACP agent, each fact, an older row, an offline machine", () => {
  const locked = "build-box's keychain is locked. Log in on its screen once, or sign in again.";
  const fleet = [
    box([claude('ready'), codex('missing', 'Not installed on build-box'), gemini('signin', 'Sign in on build-box: login or key')]),
    box([claude('signin', 'Sign in on two'), codex('ready'), gemini('ready')], { id: 'two', name: 'two' }),
    box([claude('signin', locked)], { id: 'three', name: 'three' }),
    box([claude('signin')], { id: 'four', name: 'four' }),
    box([], { id: 'old', name: 'old-host' }),
    box([claude('missing')], { id: 'down', name: 'down', status: 'offline', note: 'Offline' }),
  ];
  const why = (agent?: string) => targetsFor(fleet, 'local', false, agent).map((t) => t.reason);
  assert.deepEqual(why('claude'), [null, 'Sign in to Claude Code on two', locked, 'Sign in to Claude Code on four.', null, 'Offline']);
  assert.deepEqual(why('codex'), ["Codex isn't installed on build-box.", null, null, null, null, 'Offline']);
  assert.deepEqual(why('gemini'), ['Sign in to Gemini CLI on build-box: login or key', null, null, null, null, 'Offline']);
  // no agent named (a new chat, or a chat whose agent is unknown): nothing is judged here, the Host answers at the press
  assert.deepEqual(why(), [null, null, null, null, null, 'Offline']);
  // a machine that needs attention for its own reason keeps that line when the chat's agent is fine, and the agent's line when it is not
  const attention = box([claude('ready')], { status: 'attention', note: 'Needs login' });
  assert.equal(targetsFor([attention], 'local', false, 'claude')[0].reason, 'Needs login');
  assert.equal(
    targetsFor([{ ...attention, agents: [claude('missing')] }], 'local', false, 'claude')[0].reason,
    "Claude Code isn't installed on build-box.",
  );
});

test("the dialog gets the chat's agent: a row it cannot take is off with its reason and the first ready one is picked", async () => {
  const fleet = [box([codex('signin', 'Sign in on build-box: login')]), box([codex('ready')], { id: 'ok', name: 'ready-box' })];
  const m = await open({ machines: fleet, agent: 'codex' });
  try {
    assert.deepEqual(
      rows().map((r) => [$('.switch-host-name', r).textContent, $('.switch-host-note', r).textContent, (r as HTMLButtonElement).disabled]),
      [
        ['build-box', 'Sign in to Codex on build-box: login', true],
        ['ready-box', 'SSH', false],
      ],
    );
    assert.equal(rows()[1].getAttribute('aria-checked'), 'true');
  } finally {
    await m.unmount();
  }
});

test('while a switch is under way the form is locked and Escape does not close it; Escape closes otherwise', async () => {
  let finish!: () => void;
  const m = await open({ onContinue: () => new Promise<void>((r) => (finish = r)) });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.equal(submit().textContent, 'Switching…');
    assert.equal((submit() as HTMLButtonElement).disabled, true);
    assert.equal(dirInput().readOnly, true, 'read-only, not disabled: the keyboard stays in the field');
    assert.ok(rows().every((r) => (r as HTMLButtonElement).disabled));
    assert.equal(($$('.acct-dialog-actions button')[0] as HTMLButtonElement).disabled, true, 'Cancel waits too');
    await enter(dirInput());
    await key($('.sketch-backdrop'), 'Escape');
    assert.equal(closed, 0);
    await act(async () => finish());
    assert.equal(closed, 1);
  } finally {
    await m.unmount();
  }
  const idle = await open();
  try {
    await key($('.sketch-backdrop'), 'Escape', { isComposing: true });
    await key($('.sketch-backdrop'), 'a');
    assert.equal(closed, 1, 'a composing Escape and other keys do nothing');
    await key($('.sketch-backdrop'), 'Escape');
    assert.equal(closed, 2);
    await click($$('.acct-dialog-actions button')[0]);
    assert.equal(closed, 3, 'Cancel closes');
    assert.equal(calls.length, 0);
  } finally {
    await idle.unmount();
  }
});

test('#4951: a message on its way blocks the switch with its own reason, and a Host refusal of a busy chat does not tell the person to stop a turn that is not shown', async () => {
  const m = await open({ queued: true });
  try {
    await type(dirInput(), '/srv/app');
    assert.equal(hint(), 'Wait for your message to send.');
    assert.equal((submit() as HTMLButtonElement).disabled, true);
    await m.render(createElement(SwitchHostDialog, base({ queued: false }) as any));
    assert.equal(hint(), null, 'the reason goes when the message is in');
  } finally {
    await m.unmount();
  }
  assert.equal(refusalCopy('turn_running', 'ubuntu'), 'The chat is busy. Wait for it to finish, or stop it, then try again.');
});

test('a running turn blocks the switch with its reason; a turn that starts while the dialog is open does too', async () => {
  const m = await open({ turnRunning: true });
  try {
    await type(dirInput(), '/srv/app');
    assert.equal(hint(), 'Stop the running turn first.');
    assert.equal((submit() as HTMLButtonElement).disabled, true);
    await enter(dirInput());
    assert.equal(calls.length, 0);
    await m.render(createElement(SwitchHostDialog, base({ turnRunning: false }) as any));
    assert.equal(hint(), null, 'the reason goes when the turn ends');
  } finally {
    await m.unmount();
  }
});

test('with no machine to pick, the dialog says so and offers no folder field', async () => {
  for (const machines of [[], FLEET.slice(0, 1), FLEET.slice(0, 3)]) {
    const m = await open({ machines });
    try {
      assert.equal($('[role=radiogroup]') === null, machines.length < 2);
      assert.equal(dirInput(), null);
      assert.equal(hint(), machines.length < 2 ? 'No other host.' : 'Pick a host.');
      assert.equal((submit() as HTMLButtonElement).disabled, true);
    } finally {
      await m.unmount();
    }
  }
});

test('a lost owner is listed again; switching asks first, Back returns, and the yes travels with the request', async () => {
  const lost = { ownerId: 'box', ownerLost: true };
  const m = await open(lost);
  try {
    assert.deepEqual(
      rows().map((r) => $('.switch-host-name', r).textContent),
      ['This Mac', 'build-box', 'lab', 'dev-vm', 'gpu-rig'],
    );
    assert.equal((rows()[1] as HTMLButtonElement).disabled, true, 'the owner is offline, so it cannot be picked');
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.equal(calls.length, 0, 'nothing is sent before the answer');
    assert.equal(
      hint(),
      "build-box isn't reachable. Continue on This Mac from this Mac's copy of the chat? Anything build-box hasn't sent yet is left out.",
    );
    await click($$('.acct-dialog-actions button')[0]);
    assert.equal(dirInput().value, '/srv/app', 'Back keeps the form');
    await enter(dirInput());
    assert.ok(hint()!.startsWith("build-box isn't reachable."), 'Enter asks too');
    await click($$('.acct-dialog-actions button')[1]);
    assert.deepEqual(calls, [{ chatId: 'c1', targetHostId: 'local', cwd: '/srv/app', lostHostConfirmed: true }]);
    assert.equal(closed, 1);
  } finally {
    await m.unmount();
  }
  const unnamed = await open({ ownerId: 'ghost', ownerLost: true });
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    assert.ok(hint()!.startsWith("ghost isn't reachable. Continue on This Mac"), 'an owner that left the list is named by its id');
  } finally {
    await unnamed.unmount();
  }
});

test('the confirmation follows the form: a turn that starts, or a machine that goes, meanwhile', async () => {
  const lost = { ownerId: 'box', ownerLost: true };
  const m = await open(lost);
  try {
    await type(dirInput(), '/srv/app');
    await click(submit());
    await m.render(createElement(SwitchHostDialog, base({ ...lost, turnRunning: true }) as any));
    const go = $$('.acct-dialog-actions button')[1] as HTMLButtonElement;
    assert.equal(go.disabled, true, 'a running turn blocks Continue anyway');
    await click(go);
    assert.equal(calls.length, 0);
    await m.render(createElement(SwitchHostDialog, base({ ...lost, machines: FLEET.slice(1, 3) }) as any));
    assert.ok(hint()!.includes('Continue on the host from'), 'a vanished target is not named');
  } finally {
    await m.unmount();
  }
});

test('Browse… opens the folder picker of the machine over the dialog; a picked folder fills the field, closing it leaves the field, and Escape belongs to the picker meanwhile', async () => {
  picked.length = 0;
  const m = await open();
  try {
    await type(dirInput(), '/srv');
    await click($$('.switch-host-dir button')[0]);
    assert.deepEqual(picked, ['dev:dev-vm']);
    await key($('.sketch-backdrop'), 'Escape');
    assert.equal(closed, 0, 'Escape does not close the dialog under the picker');
    await click($('#shut'));
    assert.equal(dirInput().value, '/srv', 'closing the picker keeps the folder');
    assert.equal($('#pick'), null);
    assert.ok($('[role=dialog]').contains(document.activeElement), 'focus is back in the dialog');
    await click($$('.switch-host-dir button')[0]);
    await click($('#pick'));
    assert.equal(dirInput().value, '/srv/picked');
    assert.equal($('#pick'), null);
    await click(submit());
    assert.equal(calls.at(-1).cwd, '/srv/picked');
  } finally {
    await m.unmount();
  }
});

test('the remembered folder of one machine and project never answers for another', async () => {
  const { rememberDirectory } = await import('../src/lib/hostSwitch.ts');
  rememberDirectory('c', 'a:b', '/one');
  assert.equal(lastDirectory('b:c', 'a'), '');
  assert.equal(lastDirectory('c', 'a:b'), '/one');
});

test('a storage that refuses neither remembers nor breaks the dialog', async () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  try {
    const m = await open();
    try {
      assert.equal(dirInput().value, '');
      await type(dirInput(), '/srv/app');
      await click(submit());
      assert.equal(closed, 1);
    } finally {
      await m.unmount();
    }
  } finally {
    Object.defineProperty(globalThis, 'localStorage', real);
  }
});

test("Browse… on This Mac opens the Mac's own folder picker (no Host lists its folders); a pick fills the field and cancelling leaves it", async () => {
  let answer: string | null = '/Users/me/app';
  installNativeStub({ dialog: { openFolder: async () => answer } });
  picked.length = 0;
  const m = await open({ ownerId: 'dev' });
  try {
    await click(rows().find((r) => /This Mac/.test(r.textContent!))!);
    await type(dirInput(), '/typed');
    answer = null;
    await click($$('.switch-host-dir button')[0]);
    assert.equal(dirInput().value, '/typed', 'cancelling keeps the field');
    answer = '/Users/me/app';
    await click($$('.switch-host-dir button')[0]);
    assert.equal(dirInput().value, '/Users/me/app');
    assert.deepEqual(picked, [], 'the remote folder picker never opens for This Mac');
    assert.equal($('#pick'), null);
  } finally {
    await m.unmount();
  }
});
