// A missing harness's official install commands: the recommended one with Install, the others behind "Other ways to
// install", each with Copy and Run in a terminal main owns (it keeps going when this page closes, and every window
// shows it); how long a run has taken, a way out of a slow one, and what came of it once the harness has been looked
// for again. Everything comes from the shared install table; nothing here asks which harness it is.
import { useEffect, useState } from 'react';
import { installLines, type InstallLine } from '../../../shared/harnessInstall.mjs';
import { native } from '../../lib/native';
import { platform } from '../../lib/platform';
import { copyText } from '../../session/clipboard';
import { openLink } from '../../session/open';
import { errorText, ignoring } from '../../lib/ignored';
import { toast } from '../../store/core';
import { recheckHarness, runTransport, useHarnessRuns, useRunOf, type HarnessRun } from '../../session/harness/harnessRuns';
import { clockText, useElapsed, useFoundPoll } from './installWatch';
import type { Presence } from '../../session/harness/installable';
import { TermView } from '../panels/TerminalPanel';
import { Check, Copy, Spinner } from '../ui/icons';
import { InstallGuidance } from './InstallGuidance';

const NODE_URL = 'https://nodejs.org/';
/** How long a copy button says it copied. */
const COPIED_MS = 1500;
/** How long a run goes before it is offered a way out (Stop · Try another way). */
export const SLOW_RUN_S = 90;

/** Copy a command; the button says it copied for a moment. */
function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn-pill icon install-copy"
      title={copied ? 'Copied' : 'Copy command'}
      aria-label={copied ? 'Copied' : `Copy the ${label} command`}
      onClick={() => copyText(command, () => setCopied(true))}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** Start a line; a run of the same package manager started in another window first says so. */
async function start(item: Presence, line: InstallLine) {
  try {
    const r = await native.harnessRuns.start(item.kind, line.index);
    if (r.ok) return;
    if (r.error === 'busy') toast(`Another ${line.label} install is running. Try again once it's done.`, 'error');
    else toast(`Couldn't run ${line.command}${r.message ? `: ${r.message}` : ''}`, 'error');
  } catch (e) {
    toast(`Couldn't run ${line.command}: ${errorText(e)}`, 'error');
  }
}

/** The line an install run came from, then the next one this machine can run after it: the way to try instead. None
 * for an update (it is no line here) or a harness already found: another install would go over it. */
function nextAfter(item: Presence, lines: InstallLine[], run: HarnessRun | null, busy: readonly string[]) {
  if (!run || run.purpose !== 'install' || item.state === 'present') return null;
  const at = lines.findIndex((l) => l.via === run.via && l.command === run.command);
  if (at < 0) return null;
  return lines.slice(at + 1).find((l) => !l.blocked && !(l.group && busy.includes(l.group))) ?? null;
}

/** What came of an ended run, once the harness has been looked for again. */
function Outcome({
  item,
  run,
  output,
  another,
  onSetLocation,
}: {
  item: Presence;
  run: HarnessRun;
  output: () => void;
  /** the next way to install, when there is one */
  another: (() => void) | null;
  onSetLocation: () => void;
}) {
  const dismiss = () => void native.harnessRuns.dismiss(run.id);
  if (item.state === 'present')
    return (
      <div className="install-outcome ok" role="status">
        <Check size={13} />
        <span>
          {item.label}
          {item.version ? ` ${item.version}` : ''} installed.
        </span>
        <button type="button" className="btn-pill" onClick={dismiss}>
          Done
        </button>
      </div>
    );
  const recheck = () => void recheckHarness(item.kind).catch((e) => toast(`Couldn't check for ${item.label}: ${errorText(e)}`, 'error'));
  if (run.code === 0)
    return (
      // main looked in every usual install folder; one it still can't see is pointed at by hand
      <div className="install-outcome warn" role="status">
        <span>{item.label} installed, but MoPilot can't find it yet.</span>
        <button type="button" className="btn-pill" onClick={recheck}>
          Re-check
        </button>
        <button type="button" className="btn-pill" onClick={onSetLocation}>
          Locate…
        </button>
      </div>
    );
  return (
    <div className="install-outcome warn" role="status">
      {/* the command and its exit code stay behind Show output */}
      <span>{run.stopped ? `Stopped installing ${item.label}.` : `Couldn't install ${item.label}.`}</span>
      {another && (
        <button type="button" className="btn-pill primary" onClick={another}>
          Try another way
        </button>
      )}
      <button type="button" className="btn-pill" onClick={output}>
        Show output
      </button>
    </div>
  );
}

export function InstallLines({ item, onSetLocation }: { item: Presence; onSetLocation: () => void }) {
  const tools = useHarnessRuns((s) => s.tools);
  const run = useRunOf(item.kind);
  const settled = useHarnessRuns((s) => (run ? !!s.settled[run.id] : false));
  // another harness's run of the same package manager, which a line of that manager waits for
  // (a string: a selector's new array each time would render without end)
  const busy = useHarnessRuns((s) =>
    s.runs
      .filter((r) => r.state === 'running' && r.kind !== item.kind && r.group)
      .map((r) => r.group)
      .join(' '),
  ).split(' ');
  const running = run?.state === 'running';
  const lines = installLines(item.kind, platform, tools);
  const pick = lines.find((l) => l.recommended) ?? null;
  // a new run hides the last one's output again
  const [outputOf, setOutputOf] = useState<string | null>(null);
  const showOutput = !!run && outputOf === run.id;
  const [others, setOthers] = useState(false);
  const isRun = (l: InstallLine) => !!run && run.via === l.via && run.command === l.command;
  // the other ways stay open while one of them is the run shown
  const othersOpen = others || (!!run && !!pick && !isRun(pick) && lines.some(isRun));
  const elapsed = useElapsed(running ? run.startedAt : null);
  const slow = running && elapsed >= SLOW_RUN_S;
  const next = nextAfter(item, lines, run, busy);
  // installed in the user's own terminal (or found after a run): its row moves on without a click
  useFoundPoll(item.kind, item.state !== 'present' && !running);
  const another = next
    ? async () => {
        setOthers(true);
        // one that already ended needs no stop; a new run of the harness replaces its result either way
        if (running) await native.harnessRuns.stop(run.id).catch(ignoring('stop a slow install'));
        await start(item, next);
      }
    : null;
  const line = (l: InstallLine) => {
    const waits = !!l.group && busy.includes(l.group);
    const mine = running && isRun(l);
    return (
      <div
        key={l.index}
        className={`install-line ${l.blocked ? 'blocked' : ''} ${l === pick ? 'recommended' : ''}`}
        data-install-line={l.via}
      >
        <span className="install-via">{l.label}</span>
        <code className="install-cmd" title={l.command} aria-label={`Install command for ${item.label} with ${l.label}`}>
          {l.command}
        </code>
        {mine ? (
          <span className="install-running" role="status">
            <Spinner size={12} /> {run?.stopped ? 'Stopping…' : 'Installing…'} {clockText(elapsed)}
          </span>
        ) : (
          <button
            type="button"
            className={`btn-pill ${l === pick ? 'primary' : ''}`}
            // once found, the card only reports the result: running a line again would reinstall over it
            disabled={!!l.blocked || running || waits || item.state === 'present'}
            title={waits ? `Another ${l.label} install is running` : 'Runs automatically; output appears below'}
            aria-label={`Run ${l.command}`}
            onClick={() => void start(item, l)}
          >
            {l === pick ? 'Install' : 'Run'}
          </button>
        )}
        <CopyCommand command={l.command} label={l.label} />
        {(l.blocked || l.note || waits) && (
          <span className="install-why">
            {waits ? `Another ${l.label} install is running` : (l.blocked ?? l.note)}
            {l.blocked && l.note && <> · {l.note}</>}
            {l.blocked === 'Needs Node.js' && (
              <>
                {' · '}
                <button type="button" className="text-link" onClick={() => openLink(NODE_URL)}>
                  nodejs.org ↗
                </button>
              </>
            )}
          </span>
        )}
      </div>
    );
  };
  const rest = lines.filter((l) => l !== pick);
  return (
    <div className="install-lines">
      {!lines.length && <InstallGuidance item={item} commands={false} onSetLocation={onSetLocation} />}
      {/* nothing this machine can run: every line is shown, with why */}
      {pick ? line(pick) : lines.map(line)}
      {pick && rest.length > 0 && (
        <button type="button" className="text-link install-others" aria-expanded={othersOpen} onClick={() => setOthers(!othersOpen)}>
          Other ways to install
        </button>
      )}
      {pick && othersOpen && rest.map(line)}
      {run && (running || showOutput || !settled) && (
        <div className="basic-login-term install-term">
          <TermView
            tab={{ id: run.id, cwd: '', title: run.command }}
            visible
            readOnly
            transport={runTransport(run.id)}
            // the run's end comes from main's run list, after the harness has been looked for again
            onExit={() => undefined}
          />
        </div>
      )}
      {running && (
        <div className="install-foot">
          {slow && <span className="install-slow">Taking long?</span>}
          <button type="button" className="btn-pill" onClick={() => void native.harnessRuns.stop(run.id)}>
            Stop
          </button>
          {slow && another && (
            <button type="button" className="btn-pill" onClick={() => void another()}>
              Try another way
            </button>
          )}
        </div>
      )}
      {run && !running && !settled && (
        <div className="install-outcome" role="status">
          <Spinner size={12} /> Looking for {item.label}…
        </div>
      )}
      {run && !running && settled && (
        <Outcome
          item={item}
          run={run}
          output={() => setOutputOf(run.id)}
          another={another && (() => void another())}
          onSetLocation={onSetLocation}
        />
      )}
    </div>
  );
}
