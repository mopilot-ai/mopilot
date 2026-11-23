// Real renderer send, early-turn and IPC proxy over the mounted handoff tests' store and fake native boundary.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { parseSync } from 'vite';
import { state, setStore } from './thread-kit.ts';

export const renderer = { sessionOf: (_id: string): any => ({}) };
const core = {
  get: () => ({ chatConfig: {}, handoffCarry: {}, ...state }),
  set: setStore,
  toast() {},
  patchRuntime(id: string, change: any) {
    const current = state.runtime[id] ?? { turns: [], activeTurnId: null };
    setStore({ runtime: { ...state.runtime, [id]: { ...current, ...change(current) } } });
  },
  newTurn: (id: string) => ({ id, status: 'inProgress', items: [] }),
  patchTurn() {},
  setDraft() {},
};
/** Where each chat runs (src/lib/hostChats.ts hostOfChatNow): '' is this Mac, a name is a machine, null is not known yet (onMachineNow then says it may be on one). */
export const hostChats = {
  hostOfChatNow: (_id: string | null): string | null => '',
  onMachineNow: (id: string | null): boolean => hostChats.hostOfChatNow(id) !== '',
};
(globalThis as any).__handoffRenderer = { core, renderer, hostChats };
const source = new URL('../../src/store/send.ts', import.meta.url);
const stubs = new Map<string, string>();
for (const statement of parseSync(source.pathname, readFileSync(source, 'utf8')).module.staticImports) {
  const specifier = statement.moduleRequest.value;
  if (
    specifier.startsWith('../../shared/') ||
    ['../harness/adapters/proxy', '../lib/ignored', './pendingTurns', './earlyTurn'].includes(specifier)
  )
    continue;
  const names = statement.entries
    .filter((e: any) => !e.isType)
    .map((e: any) => e.importName.name)
    .filter(Boolean);
  if (!names.length) continue;
  let code = names.map((n: string) => `export const ${n}=()=>undefined;`).join('\n');
  if (specifier === './core') code = names.map((n: string) => `export const ${n}=globalThis.__handoffRenderer.core.${n};`).join('\n');
  if (specifier === './session/useSession')
    code =
      'export const sessionOf=(id)=>globalThis.__handoffRenderer.renderer.sessionOf(id);export const setSession=()=>Promise.resolve(true);' +
      'export const flushSessionPatches=()=>{};';
  if (specifier === '../lib/hostChats')
    code =
      'export const hostOfChatNow=(id)=>globalThis.__handoffRenderer.hostChats.hostOfChatNow(id);export const onMachineNow=(id)=>globalThis.__handoffRenderer.hostChats.onMachineNow(id);';
  if (specifier === './session/sessionState') code = "export const turnBusy=(s)=>s.turn==='running';";
  stubs.set(specifier, code);
}
const early = new URL('../../src/store/earlyTurn.ts', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    let code = context.parentURL === source.href ? stubs.get(specifier) : undefined;
    if (context.parentURL === early.href && specifier === './core')
      code =
        'export const newTurn=globalThis.__handoffRenderer.core.newTurn;export const patchRuntime=globalThis.__handoffRenderer.core.patchRuntime;';
    return code === undefined ? next(specifier, context) : { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(code) };
  },
});
export const { sendMessage } = await import('../../src/store/send.ts');
