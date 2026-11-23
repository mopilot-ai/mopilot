// Self-contained serialized browser-script worker bootstrap and realm hardening.

/**
 * The worker's entry, one per chat's script session: a context with no Node globals and no code
 * generation from strings, and the runtime inside it. Each { t: 'run', run, code, current } message
 * compiles a call's code as an async function (lines keep their numbers, + 1) in that same context, its
 * top-level declarations kept for the next call (`keep`), and `tab` set to the chat's current tab.
 * Every other message is an answer for the runtime.
 */
function workerMain(port, vm, runtimeSource, data, toBody, keep) {
  const sandbox = Object.create(null);
  const ctx = vm.createContext(sandbox, { name: 'browser_script', codeGeneration: { strings: false, wasm: false } });
  // nothing thrown here may reach the script: an error of this realm would lead back to its Function
  const send = (msg) => {
    try {
      port.postMessage(String(msg));
    } catch {
      // the channel to main failed, so no answer can come back: closing it ends this worker, and main tells
      // the script's caller that it stopped (script.cjs, the worker's exit)
      port.close();
    }
  };
  const rt = vm.runInContext(runtimeSource, ctx, { filename: 'mopilot-browser-runtime' })(send, data.init);
  for (const k of Object.keys(rt.globals)) sandbox[k] = rt.globals[k];
  const compile = (code) => new vm.Script(`(async () => {\n${toBody(vm, code)}\n})`, { filename: 'browser_script' }).runInContext(ctx);
  port.on('message', (msg) => {
    let m;
    try {
      m = JSON.parse(String(msg));
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.t !== 'run') return rt.receive(String(msg));
    sandbox.tab = rt.tabFor(m.current ?? null);
    const code = String(m.code);
    let fn;
    try {
      try {
        fn = compile(keep(code));
      } catch {
        // the kept form didn't compile: run the code as written (its declarations stay local)
        fn = compile(code);
      }
    } catch (e) {
      const line = /^browser_script:(\d+)/.exec(String(e.stack));
      send(
        JSON.stringify({
          t: 'done',
          run: m.run,
          ok: false,
          error: { name: String(e.name), message: String(e.message), code: 'syntax', line: line ? Number(line[1]) - 1 : null, stack: '' },
        }),
      );
      return;
    }
    rt.start(fn, m.run);
  });
}

/**
 * Second line of defense, run first in the worker: should a value of the worker's realm ever reach the
 * script, its constructors lead nowhere (no Function, so no code from strings) and the worker's global
 * has no process, require or network. `ctors` are that realm's Function, AsyncFunction,
 * GeneratorFunction and AsyncGeneratorFunction.
 */
function hardenRealm(g, ctors) {
  for (const C of ctors) Object.defineProperty(C.prototype, 'constructor', { value: undefined, writable: false, configurable: false });
  for (const k of ['process', 'require', 'module', 'exports', 'Buffer', 'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'eval'])
    delete g[k];
}

module.exports = { workerMain, hardenRealm };
