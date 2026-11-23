// Executes extracted fixture/spec callbacks against inert boundaries, and guards the fake entrypoint's awaited login.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { agentRow, welcomeHeading } from './e2e/fixtures/welcome';
import { test } from 'node:test';
import { parseSync, transformSync } from 'rolldown/experimental';

const source = (url: URL) => {
  const relative = fileURLToPath(url);
  const text = readFileSync(url, 'utf8');
  const parsed = parseSync(relative, text);
  assert.deepEqual(parsed.errors, []);
  return { text, ast: parsed.program };
};
function find(file: ReturnType<typeof source>, predicate: (node: any) => boolean): any {
  let result: any;
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) result = node;
    else
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
  };
  visit(file.ast);
  assert.ok(result, 'contract node is present');
  return result;
}
function callback(file: ReturnType<typeof source>, node: any, context: Record<string, unknown>) {
  const out = transformSync('callback.ts', `(${file.text.slice(node.start, node.end)})`);
  assert.deepEqual(out.errors, []);
  return vm.runInNewContext(out.code, context);
}

test('the real harness hold API uses the wrapper state directory and refuses unconfigured identities', () => {
  const file = source(new URL('./e2e/fixtures/app.ts', import.meta.url));
  const hold = find(file, (node) => node.type === 'Property' && node.key.name === 'holdAcpLogin');
  const calls: string[] = [];
  const release = () => {};
  const invoke = callback(file, hold.value, {
    acp: { gemini: {} },
    dir: '/inert/profile',
    path,
    holdAcpLogin: (state: string) => {
      calls.push(state);
      return release;
    },
  });
  assert.equal(invoke('gemini'), release);
  assert.deepEqual(calls, ['/inert/profile/fake-acp-gemini-state']);
  assert.throws(() => invoke('kimi'), /No fake ACP harness configured/);
  assert.throws(() => invoke('toString'), /No fake ACP harness configured/);
  assert.equal(calls.length, 1);
  const wrapperState = find(file, (node) => node.type === 'Property' && node.key.name === 'FAKE_ACP_STATE');
  assert.equal(callback(file, wrapperState.value, { path, dir: '/inert/profile', id: 'gemini' }), calls[0]);
});

const welcome = source(new URL('./e2e/welcome.spec.ts', import.meta.url));
const signedOut = find(
  welcome,
  (node) =>
    node.type === 'CallExpression' &&
    node.callee.name === 'test' &&
    node.arguments[0]?.value?.includes('signs it in in an embedded terminal'),
);

for (const failure of [undefined, 'sign-in', 'terminal-login', 'terminal', 'ready', 'arrival']) {
  test(`welcome observes terminal before release and admission; finally releases on ${failure ?? 'success'}`, async () => {
    const order: string[] = [];
    let released = false;
    const error = new Error(failure);
    const found = {
      getByText: (name: string) => ({ kind: name === 'Connected' ? 'ready' : name }),
      getByRole: (_role: string, { name }: { name: string }) => ({
        click: async () => {
          const step = name === 'Sign in' ? 'sign-in' : 'terminal-login';
          assert.ok(name === 'Sign in' || name === 'Log in in terminal');
          order.push(step);
          if (failure === step) throw error;
        },
      }),
      locator: (selector: string) => {
        assert.equal(selector, '.term-view');
        return { kind: 'terminal' };
      },
    };
    const page = {
      getByRole: (role: string, options: { name: string }) => {
        if (role === 'textbox') {
          assert.equal(options.name, 'Message');
          return { kind: 'arrival' };
        }
        if (role === 'heading') {
          assert.equal(options.name, 'Connect your coding agents');
          return { kind: 'heading' };
        }
        assert.equal(role, 'list');
        assert.equal(options.name, 'Coding agents');
        return {
          getByRole: (role: string) => {
            assert.equal(role, 'listitem');
            return {
              filter: ({ has }: { has: { kind: string } }) => {
                assert.equal(has.kind, 'Gemini');
                return found;
              },
            };
          },
        };
      },
      getByText: (name: string | RegExp) => ({ kind: String(name) }),
    };
    const invoke = callback(welcome, signedOut.arguments[1], {
      welcomeHeading,
      agentRow,
      expect: (target: { kind?: string }) => ({
        toHaveCount: async () => {},
        toBeVisible: async () => {
          if (!['terminal', 'ready', 'arrival'].includes(target.kind ?? '')) return;
          assert.equal(released, target.kind !== 'terminal');
          order.push(target.kind!);
          if (target.kind === failure) throw error;
        },
      }),
    });
    const result = invoke({
      page,
      harness: {
        holdAcpLogin: (id: string) => {
          assert.equal(id, 'gemini');
          order.push('hold');
          return () => {
            released = true;
            order.push('release');
          };
        },
      },
    });
    if (failure) await assert.rejects(result, (caught) => caught === error);
    else await result;
    const steps = ['hold', 'sign-in', 'terminal-login', 'terminal', 'release', 'ready', 'arrival'];
    const expected = failure ? steps.slice(0, steps.indexOf(failure) + 1) : steps;
    assert.deepEqual(order, [...expected, 'release']);
    assert.equal(released, true);
  });
}

test('the fake entrypoint awaits terminal login before registering ACP input', () => {
  const file = source(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
  const call = find(file, (node) => node.type === 'CallExpression' && node.callee.name === 'terminalLogin');
  assert.equal(file.text.slice(call.arguments[0].start, call.arguments[0].end), 'process.argv');
  const lines = find(file, (node) => node.type === 'CallExpression' && node.callee.name === 'lines');
  assert.ok(call.end < lines.start, 'login must settle before the ACP protocol reads stdin');
  const stdin = find(
    file,
    (node) => node.type === 'CallExpression' && file.text.slice(node.callee.start, node.callee.end) === 'process.stdin.on',
  );
  assert.ok(call.end < stdin.start, 'login must settle before the stdin shutdown listener');
  assert.ok(
    file.ast.body.some(
      (node: any) => node.type === 'ExpressionStatement' && node.expression.type === 'AwaitExpression' && node.expression.argument === call,
    ),
  );
});
