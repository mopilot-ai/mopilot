// codex context exposure matrix cases using shared fake harness and controller fixtures.
import {
  describe,
  test,
  assert,
  codexConnection,
  world,
  IN_APP_BROWSER_CONTEXT,
  registration,
  acpSession,
  type Surfaces,
  bools,
  flagCombos,
  setFlags,
  injection,
  codexAvailability,
} from './fixture.ts';
import { createRequire } from 'node:module';

const tiers = createRequire(import.meta.url)('../../../electron/capabilities/mcp/toolTiers.cjs');

export function registerDegradedNotes() {
  describe('CM-X08: the native Codex degraded note', () => {
    /** A native thread on a Mac with the Browser plugin but no Codex Computer Use; the note from NativeAvailability. */
    function degradedThread() {
      const w = world();
      w.state.yourChrome = true;
      const { na, surfaces } = codexAvailability(w, { sky: false });
      const x = injection(w, {
        surfaces: () => ({ chrome: surfaces.chrome, computer: surfaces.computer }),
        degradedNote: (s: Surfaces, server: string) => na.degradedNote(s, server),
      });
      return { w, ...x };
    }
    /** turn/start: the note when due, marked as sent once the turn went through. */
    const turn = (inj: any, threadId: string) => {
      const c = inj.turnContext(threadId);
      if (c) inj.contextForwarded(threadId, c.key, inj.contextReceipt(threadId));
      return c?.context.value ?? null;
    };
    const degraded = /MoPilot native control: Computer use through the Computer plugin is unavailable.*desktop_\* tools/;

    test('CM-X08a: sent with the first turn of a load, not again until a compaction', () => {
      const { inj, load } = degradedThread();
      load('thread/start', 'cx-1');
      assert.equal(inj.turnContext('cx-1')?.key, IN_APP_BROWSER_CONTEXT);
      const first = turn(inj, 'cx-1');
      assert.match(first ?? '', degraded);
      // the note above was forwarded: later turns don't repeat it
      assert.equal(turn(inj, 'cx-1'), null);
      assert.equal(turn(inj, 'cx-1'), null);
      inj.observe({ method: 'thread/compacted', params: { threadId: 'cx-1' } });
      assert.match(turn(inj, 'cx-1') ?? '', degraded, 'again after thread/compacted');
      assert.equal(turn(inj, 'cx-1'), null);
      inj.observe({ method: 'item/completed', params: { threadId: 'cx-1', item: { type: 'contextCompaction' } } });
      assert.match(turn(inj, 'cx-1') ?? '', degraded, 'again after a contextCompaction item');
      assert.equal(turn(inj, 'cx-1'), null);
    });

    test('CM-X08b: a chat that switched away (Codex unloads the thread) and back (resume) gets the note again, once', () => {
      const { inj, load } = degradedThread();
      load('thread/start', 'cx-1');
      assert.match(turn(inj, 'cx-1') ?? '', degraded);
      // switched to Claude for a while, then back before Codex let the thread go: it is still loaded with the note
      load('thread/resume', 'cx-1');
      assert.equal(turn(inj, 'cx-1'), null, 'still loaded: the note is in its context');
      // switched away long enough for Codex to unload it, then back
      inj.observe({ method: 'thread/closed', params: { threadId: 'cx-1' } });
      load('thread/resume', 'cx-1');
      assert.match(turn(inj, 'cx-1') ?? '', degraded, 'again after the reload');
      assert.equal(turn(inj, 'cx-1'), null);
    });

    test('CM-X08c: a note not forwarded (the turn/start failed) is offered again on the next turn', () => {
      const { inj, load } = degradedThread();
      load('thread/start', 'cx-1');
      assert.match(inj.turnContext('cx-1')?.context.value ?? '', degraded);
      assert.match(inj.turnContext('cx-1')?.context.value ?? '', degraded);
    });

    test('CM-X08d: a managed thread and a fully native one with nothing missing get no degraded note', () => {
      const w = world();
      const managed = injection(w, { degradedNote: () => 'MoPilot native control: x' });
      managed.load('thread/start', 'cx-m');
      // a managed thread gets the shared note on what MoPilot's tools reach (#1319 G3), never the degraded one
      assert.doesNotMatch(managed.inj.turnContext('cx-m')?.context.value ?? '', /native control/);
      const { na, surfaces } = codexAvailability(w, {});
      const full = injection(w, {
        surfaces: () => ({ chrome: surfaces.chrome, computer: surfaces.computer }),
        degradedNote: (s: Surfaces, server: string) => na.degradedNote(s, server),
      });
      full.load('thread/start', 'cx-n');
      const note = full.inj.turnContext('cx-n')?.context.value ?? '';
      assert.doesNotMatch(note, /native control/);
      assert.match(note, /Browser routing in MoPilot/, 'the built-in browser note alone');
    });
  });
}

export function registerManagedParity() {
  /* ====================================================================== */
  /* CM-X09: an ACP session sees what a managed Codex thread sees            */
  /* ====================================================================== */

  describe('CM-X09: ACP and managed Codex', () => {
    test('CM-X09: an ACP sage-mcp session lists the same tools as a managed Codex thread under every switch and channel', async () => {
      const diffs: string[] = [];
      for (const yourChrome of bools)
        for (const f of flagCombos) {
          const w = world();
          setFlags(w, f);
          w.state.yourChrome = yourChrome;
          const reg = registration(w);
          reg.startup();
          const cx = codexConnection(w, (id) => id);
          const { thread } = await cx.startThread();
          const codex = await cx.session(thread.id);
          const acp = await acpSession(w);
          const cell = `${yourChrome ? 'Your Chrome' : 'built-in'} ${JSON.stringify(f)}`;
          // this Codex defers MCP tools itself and ACP is tiered: the same tools once ACP's deferred ones count as listed
          const same = (c: string[], a: string[]) =>
            JSON.stringify(c.filter((n) => tiers.groupOf(n) === null)) === JSON.stringify(a.filter((n) => !n.endsWith('_more_tools')));
          if (!same(codex.tools, acp.tools)) diffs.push(`${cell}: codex ${codex.tools.join(',')} vs acp ${acp.tools.join(',')}`);
          // and both follow a change the same way
          w.state.yourChrome = !yourChrome;
          const [c2, a2] = [(await cx.session(thread.id)).tools, await acp.list()];
          if (!same(c2, a2)) diffs.push(`${cell} after a channel flip: codex ${c2} vs acp ${a2}`);
        }
      assert.deepEqual(diffs, []);
    });
  });
}
