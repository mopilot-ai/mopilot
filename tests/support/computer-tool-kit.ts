// What the desktop_* and desktop_app_* tool kits share (desktop-kit.ts, app-scoped-kit.ts): the apps the tests use,
// the approval broker that records each card, the computer-use coordinator over the real ComputerPermissions, and
// the ToolError check.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sessionAnchorOf } = require('../../electron/capabilities/anchor.cjs');
const { ComputerPermissions } = require('../../electron/capabilities/tools/computerPermissions.cjs');
export const { ToolError } = require('../../electron/capabilities/contract/registry.cjs');

export const NOTES = { pid: 7, bundleId: 'com.apple.Notes', name: 'Notes' };
export const MAIL = { pid: 8, bundleId: 'com.apple.mail', name: 'Mail' };
export const TERMINAL = { pid: 9, bundleId: 'com.apple.Terminal', name: 'Terminal' };
export const SAFARI = { pid: 10, bundleId: 'com.apple.Safari', name: 'Safari' };

/** The approval broker: records each card it is asked and answers from `answers` by kind (a function gets the params). */
export function recordingBroker(answers: Record<string, any>) {
  const asks: { chatId: string; kind: string; params: any }[] = [];
  const broker = {
    ask: async (chatId: string, kind: string, params: any) => {
      asks.push({ chatId, kind, params });
      const a = answers[kind];
      return typeof a === 'function' ? a(params) : a;
    },
  };
  return { broker, asks };
}

/**
 * The computer-use coordinator the tools ask: the real ComputerPermissions (its activity recorded) with no chat in
 * control, every chat its own, a Claude Code session in default permissions, and `state` deciding the unattended
 * answers. `more` adds or replaces members; it gets the coordinator, for members that read it.
 */
export function computerUse(state: any, more: (cu: any) => Record<string, any> = () => ({})) {
  const activity: any[] = [];
  const paused: any[] = [];
  const cu: any = Object.assign(new ComputerPermissions((chatId: string, a: any) => activity.push([chatId, a])), {
    controlling: null,
    liveHolder: () => cu.controlling,
    app: null,
    chatOf: (id: string) => id,
    session: () => state.session,
    harness: () => 'claude',
    anchor: (id: string) => sessionAnchorOf(cu.harness(id), cu.session(id)),
    unattended: async () => state.unattended,
    unattendedAllowed: () => state.unattendedAllowed,
    onUnattended: (chatId: string, e: any) => paused.push({ chatId, ...e }),
    release: async () => {},
  });
  Object.assign(cu, more(cu));
  return { cu, activity, paused };
}

/** A tool call in chat c1 by default, its first result's text, and the helper's calls of one method. */
export function toolCalls(run: (tool: string, args: any, ctx: any) => Promise<any>, helper: { calls: any[] }) {
  const call = (tool: string, args: any = {}, ctx: any = { chatId: 'c1' }) => run(tool, args, ctx);
  const text = async (tool: string, args: any = {}, ctx?: any) => (await call(tool, args, ctx))[0].text;
  const callsOf = (m: string): any[] => helper.calls.filter((c: any) => c.method === m);
  return { call, text, callsOf };
}

/** The call fails with a ToolError of `code` (and a message matching `re`). */
export const rejects = (p: Promise<any>, code: string, re?: RegExp) =>
  assert.rejects(p, (e: any) => {
    assert.ok(e instanceof ToolError, `a ToolError, got ${e}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
