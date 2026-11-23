// Task routing must resolve the adapters main installs (src/store/runtime.ts) after cyclic renderer modules finish
// initializing.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, stop } from 'esbuild';

export const GUARDS = ['src/store/agentWiring.ts', 'src/store/backgroundTasks.ts', 'src/store/runtime.ts', 'src/session/harness/claude.ts'];

const root = fileURLToPath(new URL('../', import.meta.url));
const wiring = fileURLToPath(new URL('../src/store/agentWiring.ts', import.meta.url));
const background = fileURLToPath(new URL('../src/store/backgroundTasks.ts', import.meta.url));
const runtime = fileURLToPath(new URL('../src/store/runtime.ts', import.meta.url));
const fixtures: Record<string, string> = {
  claude: `
    import { wireAgentSurfaces } from ${JSON.stringify(wiring)};
    import { installRuntime } from ${JSON.stringify(runtime)};
    export const calls = [];
    export const stopClaudeTask = async (chat, task) => { calls.push(chat + ':' + task.id); return true; };
    export async function claudeMoveToBackground() { return true; }
    // as main does: the runtime first, then boot wires the surfaces
    export function initialize() { installRuntime({ stopClaudeTask, claudeMoveToBackground }); wireAgentSurfaces(); }
  `,
  react: 'export function useEffect() {} export function useSyncExternalStore() {}',
  './codexAgents': 'export async function loadCodexAgentThread() {}',
  './agentThreads': 'export function agentThread() { return { items: [] }; } export function setAgentThreadLoaderResolver() {}',
  './codexTasks': `
    export function shouldPollTasks() { return false; }
    export async function stopCodexTask() { return true; }
    export function codexTaskOutput() {}
    export function startCodexTaskPoller() {}
    export function stopCodexTaskPoller() {}
  `,
  './chatFamily': `
    export function taskSourceKey() { return JSON.stringify(['claude', 'native']); }
    export function taskSourceAt() {}
  `,
  './chats': "export function chatFamily() { return 'claude'; }",
  '../lib/findAgentRun': 'export function findNestedAgentRun() {}',
  './core': 'export function toast() {} export function useStore() {} export function get() { return { runtime: {}, segments: {} }; }',
};

after(() => stop());

for (const first of ['claude', wiring]) {
  test(`task stop reaches the late-initialized adapter when ${first === 'claude' ? 'the harness' : 'the wiring'} loads first`, async () => {
    // The real renderer has Claude -> store -> boot -> agentWiring, and main installs Claude in the runtime. Its const
    // export is assigned after the wiring module evaluates; already-initialized mock exports miss this order.
    const result = await build({
      absWorkingDir: root,
      stdin: {
        contents: `
          import ${JSON.stringify(first)};
          import { initialize, calls } from 'claude';
          import { stopBackgroundTask } from ${JSON.stringify(background)};
          export { calls };
          export async function run() {
            initialize();
            return stopBackgroundTask('chat', { id: 'native-task', status: 'running', source: { kind: 'claude', key: 'native' } });
          }
        `,
        resolveDir: root,
      },
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      sourcemap: 'inline',
      plugins: [
        {
          name: 'cyclic-adapter-boundaries',
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              const key = args.path === '../harness/claude' ? 'claude' : args.path;
              if (Object.hasOwn(fixtures, key)) return { path: key, namespace: 'fixture' };
            });
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
              contents: fixtures[args.path],
              loader: 'js',
              resolveDir: root,
            }));
          },
        },
      ],
    });
    const module = { exports: {} as { run(): Promise<boolean>; calls: string[] } };
    vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console }, { filename: 'task-wiring-cycle.cjs' });
    assert.equal(await module.exports.run(), true, 'the task stopper must be bound after its imported const is initialized');
    assert.equal(module.exports.calls.join(','), 'chat:native-task');
  });
}
