// The Memory tab's Open loops (#2139 P4): the promises, dates and to-dos MoMo kept from what the user said in its chat, each with the user's own words, the day they said it, its due day and how often MoMo brought it up, and Done, Snooze, Dismiss; the latest closed ones with Reopen. Read again whenever the memory changes (electron/momo/loopsIpc.cjs).
import { native } from '../../lib/native';
import type { MomoLoop } from '../../lib/native/contracts/momoMemory';
import { Group, Row } from '../pages/settings/Controls';
import { day, useRead } from './memoryRead';
import { LoopActions, loopState, saidLine } from './loopActions';

const readLoops = () => native.momoMemory.loops();

function LoopRow({ loop, now }: { loop: MomoLoop; now: number }) {
  const state = loopState(loop, now);
  const chips = (
    <span className="momo-chips">
      <span className="momo-loop-quote">{saidLine(loop.quote, loop.saidAt)}</span>
      {loop.dueAt !== undefined && <span className="applies-to momo-chip">Due {loop.dueDay ?? day(loop.dueAt)}</span>}
      {loop.confidence === 'likely' && <span className="applies-to momo-chip expired">Unsure: no nudges</span>}
      {loop.nudged.some((n) => n.trigger !== 'declined') && (
        <span className="applies-to momo-chip">Nudged {loop.nudged.filter((n) => n.trigger !== 'declined').length}×</span>
      )}
      {state && <span className="applies-to momo-chip expired">{state}</span>}
    </span>
  );
  return (
    <div className="momo-fact" data-loop={loop.id}>
      <Row title={loop.text} desc={chips}>
        <LoopActions id={loop.id} open={loop.state === 'open'} title={loop.text} dueAt={loop.dueAt} dueDay={loop.dueDay} />
      </Row>
    </div>
  );
}

export function OpenLoops() {
  const { value, error, off, load } = useRead(readLoops);
  if (off) return null;
  return (
    <Group title="Open loops" desc="From what you told MoMo. Nudges come from these.">
      {error && (
        <div className="config-warning" role="alert">
          Couldn't read the open loops: {error}{' '}
          <button className="btn-pill soft" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {value && !value.open.length && <Row title="Nothing open" />}
      {value?.open.map((l) => (
        <LoopRow key={l.id} loop={l} now={value.now} />
      ))}
      {!!value?.closed.length && (
        <details className="momo-loops-closed">
          <summary>Closed ({value.closed.length})</summary>
          {value.closed.map((l) => (
            <LoopRow key={l.id} loop={l} now={value.now} />
          ))}
        </details>
      )}
    </Group>
  );
}
