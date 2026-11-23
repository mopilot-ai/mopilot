import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformWithOxc } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const fixture = {
  session: { goal: null as any, queue: [] as any[], ultracode: null },
  permission: 'default',
  controls: [] as string[],
  effort: 'medium',
  quick: false,
  quiet: null as boolean | null,
  confirm: null as null | (() => void),
  own: null as any,
  accounts: {
    active: { id: 'me', email: 'private@example.com' },
    accounts: [
      { id: 'me', email: 'private@example.com' },
      { id: 'work', email: 'work@example.com' },
    ],
  } as any,
};
(globalThis as any).__switchSheetFixture = fixture;
const source = readFileSync(new URL('../src/components/harnessPicker/SwitchSheet.tsx', import.meta.url), 'utf8');
const prelude = `
import { useId, useState } from 'react';
import { canCarryMultiAgent, defaultContinueGoal, multiAgentIsOn, sheetPlan, userQueued } from '../src/harness/switchPlan.ts';
import { COPY } from '../src/harness/copy.ts';
const HARNESS_LABEL={codex:'Codex',claude:'Claude Code'};
const useSession=()=>globalThis.__switchSheetFixture.session;
const useStore=f=>f({prefs:{permission:globalThis.__switchSheetFixture.permission},segments:{},runtime:{}});
const useHarnessStatus=()=>({email:'private@example.com'});
const useChatAccount=(h,chatId)=>globalThis.__switchSheetFixture.own;
const useHarnessAccounts=()=>globalThis.__switchSheetFixture.accounts;
import { switchAccountLabel } from '../src/harness/chatAccountLabel.ts';
const useEffectiveSelection=()=>({effort:globalThis.__switchSheetFixture.effort});
const useQuickSwitch=(quiet,confirm)=>{const f=globalThis.__switchSheetFixture;f.quiet=quiet;f.confirm=confirm;return quiet&&f.quick;};
const harnessInfo=()=>({vendor:'Anthropic'});
const HarnessIcon=()=>null,BasicHarnessIcon=()=>null,BasicBadge=()=>null;
const basicLabel=()=> 'Other agent';
const useControllerChanges=(chatId,target)=>globalThis.__switchSheetFixture.controls.map((l)=>l+' ['+chatId+'→'+target+']');
`;
const compiled = await transformWithOxc(prelude + source.slice(source.indexOf('/** What the user chose')), 'switchSheet.fragment.tsx', {
  jsx: { runtime: 'automatic' },
});
const url = new URL('./switchSheet.fragment.tsx', import.meta.url).href;
registerHooks({
  resolve(s, c, next) {
    if (s === url) return { shortCircuit: true, url };
    try {
      return next(s, c);
    } catch (e) {
      if (s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c);
      throw e;
    }
  },
  load(s, c, next) {
    return s === url ? { shortCircuit: true, format: 'module', source: compiled.code } : next(s, c);
  },
});
const { SwitchSheet } = await import(url);
const render = (account?: string | null) =>
  renderToStaticMarkup(
    createElement(SwitchSheet, {
      threadId: 'chat',
      from: 'codex',
      target: 'claude',
      model: { id: 'opus', label: 'Opus', efforts: ['medium'], defaultEffort: 'medium', autoMode: false },
      account,
      onCancel() {},
      onConfirm() {},
    }),
  );
test('routine switch shows target, timing, carryover and actions without the detailed columns', () => {
  const html = render();
  assert.match(html, /Continue on Claude Code · Opus/);
  assert.match(html, /Applies to your next message/);
  assert.match(html, /conversation and workspace carry over/);
  assert.match(html, /More options/);
  assert.match(html, />Cancel</);
  assert.match(html, />Switch</);
  assert.doesNotMatch(html, /Comes along|Stays behind|Permissions: unchanged|Multiple agents: off|private@example.com/);
});
test('the sheet says up front which effort the target model starts at', () => {
  // the source chat runs at Medium (useEffectiveSelection above); Opus has Medium, so it carries over
  assert.match(render(), /<div class="ss-line">Effort: Medium → Medium<\/div>/);
  // a target model without effort levels: no line to show
  const html = renderToStaticMarkup(
    createElement(SwitchSheet, {
      threadId: 'chat',
      from: 'codex',
      target: 'claude',
      model: { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null },
      onCancel() {},
      onConfirm() {},
    }),
  );
  assert.doesNotMatch(html, /Effort:/);
});
test('goal, queued-message choices and stricter permissions appear only when relevant', () => {
  fixture.session.goal = { objective: 'Finish the change', status: 'active' };
  fixture.session.queue = [{ text: 'next' }];
  fixture.permission = 'auto-review';
  const html = render();
  assert.match(html, /Continue the current goal/);
  assert.match(html, /1 queued messages/);
  assert.match(html, /Send after switching/);
  assert.match(html, /Leave them here/);
  assert.match(html, /Ask for approval/);
  // what another session sent, or no human wrote, is not the user's to take back: it is not counted
  fixture.session.queue = [{ text: 'next' }, { text: 'wake', sideSession: { id: 'w' } }, { text: 'routine', authored: { id: 'r' } }];
  assert.match(render(), /1 queued messages/);
  fixture.session.queue = [{ text: 'wake', sideSession: { id: 'w' } }];
  assert.doesNotMatch(render(), /queued messages/);
  fixture.session.queue = [];
  fixture.session.goal = null;
  fixture.permission = 'default';
});

test('the sheet lists each surface whose controller the switch changes, from the chat and target it shows', () => {
  fixture.controls = [];
  assert.doesNotMatch(render(), /After the switch/, 'no change: no line');
  fixture.controls = ['After the switch, your Chrome is controlled by Claude in Chrome instead of the Codex Browser plugin.'];
  assert.match(
    render(),
    /After the switch, your Chrome is controlled by Claude in Chrome instead of the Codex Browser plugin\. \[chat→claude\]/,
  );
  fixture.controls = [];
});

test("the sheet names the account the chat goes on when it is the chat's own: picked, or pinned there before (R-2)", () => {
  const line = (html: string) => /<div class="ss-line">(Account: [^<]*)<\/div>/.exec(html)?.[1] ?? null;
  assert.equal(line(render('work')), 'Account: work@example.com · Your next messages and the handoff summary go to Anthropic');
  fixture.own = { id: 'work', pinned: true, serving: 'me' };
  assert.equal(
    line(render()),
    'Account: Pinned to work@example.com · now on private@example.com · Your next messages and the handoff summary go to Anthropic',
  );
  // the pool placed it there: the harness's account in use, as for any chat, goes unnamed
  fixture.own = { id: 'work', pinned: false, serving: 'work' };
  assert.equal(line(render()), null);
  // an explicit automatic account selection is named.
  assert.equal(line(render(null)), 'Account: Automatic · Your next messages and the handoff summary go to Anthropic');
  fixture.own = null;
  // no account known at all: the status's plan names it
  fixture.accounts = { active: null, accounts: [] };
  assert.equal(line(render('gone')), 'Account: gone · Your next messages and the handoff summary go to Anthropic');
});

test('a switch with nothing at risk confirms at once with the default choices and draws nothing', () => {
  fixture.quick = true;
  const choices: any[] = [];
  const html = renderToStaticMarkup(
    createElement(SwitchSheet, {
      threadId: 'chat',
      from: 'codex',
      target: 'claude',
      model: { id: 'opus', label: 'Opus', efforts: ['medium'], defaultEffort: 'medium', autoMode: false },
      onCancel() {},
      onConfirm: (c: any) => choices.push(c),
    }),
  );
  assert.equal(html, '');
  assert.equal(fixture.quiet, true);
  fixture.confirm!();
  assert.deepEqual(choices, [{ mode: 'auto', goal: null, multiAgent: false, queued: 'send', effort: 'medium' }]);
  fixture.quick = false;
});

test('each thing at risk keeps the sheet open', () => {
  fixture.quick = true;
  const risks: [string, () => void, () => void][] = [
    ['goal', () => (fixture.session.goal = { objective: 'x', status: 'active' }), () => (fixture.session.goal = null)],
    ['queued', () => (fixture.session.queue = [{ text: 'next' }]), () => (fixture.session.queue = [])],
    ['permission', () => (fixture.permission = 'auto-review'), () => (fixture.permission = 'default')],
    ['multi-agent', () => (fixture.effort = 'ultra'), () => (fixture.effort = 'medium')],
    ['controller', () => (fixture.controls = ['c']), () => (fixture.controls = [])],
  ];
  for (const [name, on, off] of risks) {
    on();
    assert.match(render(), /Continue on Claude Code/, name);
    assert.equal(fixture.quiet, false, name);
    off();
  }
  // an account picked in the sheet is a decision too
  assert.match(render('work'), /Continue on Claude Code/);
  assert.equal(fixture.quiet, false);
  fixture.own = { id: 'work', pinned: true, serving: 'me' };
  assert.match(render(), /Continue on Claude Code/);
  assert.equal(fixture.quiet, false);
  fixture.own = null;
  fixture.quick = false;
});
