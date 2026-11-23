// Harness install runs as this window sees them: main's runs (every window shares them), what this machine has for
// the install lines, and the harness looked for again in this window once a run ends.
import { create } from 'zustand';
import { native } from '../../lib/native';
import { errorText, ignoring } from '../../lib/ignored';
import type { TermTransport } from '../terminalTransport';
import { isFirstTier } from '../../harness/adapter';
import type { HarnessKind } from '../../../shared/model/harness';
import type { HarnessFamily } from '../../harness/family';
import { HARNESS_LABEL } from '../../harness/types';
import type { HarnessId } from '../../../shared/model/harness';
import type { HarnessRun } from '../../lib/native/harnessRuns';
import type { InstallTools } from '../../../shared/harnessInstall.mjs';
import type { Say } from './claude/accounts';
import { userError } from '../../../shared/userError.mjs';

export type { HarnessRun };

export const useHarnessRuns = create<{
  runs: HarnessRun[];
  tools: InstallTools | null;
  /** ended runs this window has looked for their harness again after: their result is final */
  settled: Record<string, true>;
}>(() => ({ runs: [], tools: null, settled: {} }));

/** A registry kind's family: Codex, Claude Code, or a basic harness (with its id). */
const familyOf = (kind: string): { family: HarnessFamily; basic: string } =>
  isFirstTier(kind as HarnessKind) ? { family: kind as HarnessId, basic: '' } : { family: 'acp', basic: kind.slice('acp:'.length) };

/**
 * Look for a harness again, per family: Codex by starting its app-server again, Claude Code by detecting it, a basic
 * one by its check. The store and harness modules load when asked, so following runs at boot pulls none of them in.
 */
const RECHECK: Record<HarnessFamily, (basic: string, say?: Say) => Promise<unknown>> = {
  codex: async (_basic, say) => {
    const [{ restartCodex }, { get }] = await Promise.all([import('../../store/connection'), import('../../store/core')]);
    await restartCodex();
    // a start that failed leaves its reason in the store: said where the re-check was asked (#2034), as Claude Code's own
    const s = get();
    if (say && s.conn !== 'ready') say(userError(s.connError, { who: HARNESS_LABEL.codex }), 'error');
  },
  claude: async (_basic, say) => {
    const { detectClaude, recheckClaude } = await import('./claude');
    await detectClaude(true);
    return recheckClaude(undefined, say);
  },
  acp: async (basic) => (await import('./acp')).recheckBasic(basic),
};

/**
 * What this window asks once a run has ended and main has looked again: main started Codex's app-server again and
 * checked a basic harness (its list came first), so Codex only reconnects and Claude Code is detected here.
 */
const AFTER_RUN: Record<HarnessFamily, () => Promise<unknown>> = {
  codex: async () => (await import('../../store/connection')).connect(),
  claude: () => RECHECK.claude(''),
  acp: async () => undefined,
};

/** `say`: where what it found is said (Claude Code says it; a toast unless given), e.g. under the welcome page's row. */
export function recheckHarness(kind: string, say?: Say): Promise<unknown> {
  const { family, basic } = familyOf(kind);
  return RECHECK[family](basic, say);
}

const afterRun = (kind: string) => AFTER_RUN[familyOf(kind).family]();

/** Runs this window has seen end and be checked, so each is looked after once. */
const seen = new Set<string>();

function onRuns(runs: HarnessRun[]) {
  // anything but a list is no answer from main: keep what this window has
  if (!Array.isArray(runs)) return;
  // a run main dropped (dismissed, or replaced by a new one) needs no result any more
  const live = new Set(runs.map((r) => r.id));
  for (const id of seen) if (!live.has(id)) seen.delete(id);
  useHarnessRuns.setState((s) => ({ runs, settled: Object.fromEntries(Object.entries(s.settled).filter(([id]) => live.has(id))) }));
  for (const r of runs) {
    if (!r.checked || seen.has(r.id)) continue;
    seen.add(r.id);
    const settle = () => useHarnessRuns.setState((s) => ({ settled: { ...s.settled, [r.id]: true } }));
    afterRun(r.kind).then(settle, (e) => {
      settle();
      ignoring(`look for ${r.kind} again after its install`)(e);
    });
  }
}

/** Follow main's runs; ones that ended and were checked before this window opened were detected with it. */
export function followHarnessRuns() {
  native.harnessRuns.onState(onRuns);
  native.harnessRuns.list().then((runs) => {
    if (!Array.isArray(runs)) return;
    for (const r of runs) if (r.checked) seen.add(r.id);
    useHarnessRuns.setState((s) => ({
      runs,
      settled: { ...s.settled, ...Object.fromEntries(runs.filter((r) => r.checked).map((r) => [r.id, true as const])) },
    }));
  }, ignoring('list the harness installs under way'));
}

/** Ask main again what the install lines need (npm, Homebrew, a writable npm folder). */
export function refreshInstallTools() {
  native.harnessRuns.tools().then((tools) => useHarnessRuns.setState({ tools }), ignoring('check for npm and Homebrew'));
}

/** The run of `kind` this window shows: the one under way, else its last result. */
export const useRunOf = (kind: string) => useHarnessRuns((s) => s.runs.find((r) => r.kind === kind) ?? null);

/**
 * A terminal view onto a run main owns: the output it kept, then what follows, each byte once (data events carry the
 * run's output length, so a chunk the kept output already holds is cut, and one that came before it was read waits).
 * Closing the view leaves the run going.
 */
export const runTransport =
  (id: string): TermTransport =>
  (_tab, size, on) => {
    let alive = true;
    /** how much of the run's output the view has; -1 until the kept output is in */
    let end = -1;
    const early: { data: string; end: number }[] = [];
    const take = (e: { data: string; end: number }) => {
      if (e.end <= end) return;
      const fresh = e.data.slice(Math.max(0, e.data.length - (e.end - end)));
      end = e.end;
      on.data(fresh);
    };
    const off = native.harnessRuns.onData((e) => {
      if (e.id !== id) return;
      if (end < 0) early.push(e);
      else take(e);
    });
    native.harnessRuns.attach(id).then(
      (a) => {
        if (!alive) return;
        if (!a) return on.error('This run has ended');
        end = a.end;
        on.data(a.output);
        for (const e of early.splice(0)) take(e);
        native.harnessRuns.resize(id, size.cols, size.rows);
      },
      (e) => alive && on.error(errorText(e)),
    );
    return {
      write: (d) => native.harnessRuns.write(id, d),
      resize: (cols, rows) => native.harnessRuns.resize(id, cols, rows),
      close: () => {
        alive = false;
        off();
      },
    };
  };
