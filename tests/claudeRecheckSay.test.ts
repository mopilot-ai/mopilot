// src/session/harness/claude/accounts.ts recheckClaude: what a re-check found is said where it was asked (#2034), a toast by default.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';

const claude = await import('../src/session/harness/claude.ts');

const detected = (o: any) => {
  fx.native.claude = {
    detect: async () => ({ bin: '/bin/claude', version: '2.1', candidates: [], auth: null, plan: null, ...o }),
    probe: async () => ({ models: [], account: null, fastBlocked: null }),
    refreshAccounts: async () => fx.state.claudeAccounts,
    signInEnded: async () => {},
    list: async () => [],
    usage: async () => ({ state: 'success', text: '' }),
  };
};

beforeEach(() => reset());

test("each state is said to the re-check's own say, never toasted; one still being checked says nothing", async () => {
  const cases: [any, unknown[][]][] = [
    [{ state: 'signin' }, [['Claude Code is still signed out. Finish `claude auth login`, then re-check.', 'error']]],
    [{ state: 'missing', bin: null }, [["Claude Code isn't found. Install it, or set its location in Settings.", 'error']]],
    [{ state: 'error', error: 'boom\nstack' }, [['Claude Code: boom', 'error']]],
    // a state with no words of its own goes by its name
    [{ state: 'error', error: null }, [['Claude Code: error', 'error']]],
    [{ state: 'detecting' }, []],
  ];
  for (const [state, expected] of cases) {
    detected(state);
    const said: unknown[][] = [];
    await claude.recheckClaude(undefined, (...a) => said.push(a));
    assert.deepEqual(said, expected, state.state);
  }
  assert.deepEqual(called('toast'), []);
});
