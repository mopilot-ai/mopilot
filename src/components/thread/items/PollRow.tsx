// A folded poll: one row ("Ran the same command 4 times, waited 3m 20s") that opens to every check and its status message.
import { Fragment, memo, useState } from 'react';
import { Collapse } from '../../ui/Presence';
import { ChevronDown } from '../../ui/icons';
import type { ActivityUx } from '../../../session/activityUx';
import type { NarrationContext } from '../../../lib/agentNarration';
import { firstLine, stepIcon } from './presentation';
import { pollSummary, samePoll, type PollBlock } from './pollRuns';
import { sameNarration, StepGroup } from './StepGroups';
import { BlockItem } from './BlockItems';

type PollRowProps = {
  block: PollBlock;
  cwd: string;
  ux?: ActivityUx;
  threadId?: string;
  /** the app bindings before a check's first item, as each step group of the turn narrates with */
  narrationOf?: (id: string) => NarrationContext | undefined;
};

/** Memoized by samePoll, so a streamed delta elsewhere in the turn does not redraw a settled poll. */
export const PollRow = memo(function PollRow({ block, cwd, ux, threadId, narrationOf }: PollRowProps) {
  const [open, setOpen] = useState(false);
  const sum = pollSummary(block);
  return (
    <div className={`step-group poll-run ${open ? 'open' : ''}`}>
      <button className="step-row summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="step-icon">{stepIcon('wait')}</span>
        <span className="step-text">
          {sum.text}
          <span className="step-em"> · {firstLine(sum.target)}</span>
          {sum.failed ? <span className="step-exit"> · {sum.failed} failed</span> : null}
        </span>
        <ChevronDown size={14} className="step-chevron" />
      </button>
      <Collapse open={open}>
        <div className="step-list poll-checks">
          {block.checks.map((c) => (
            <Fragment key={c.items[0].id}>
              <StepGroup items={c.items} cwd={cwd} ux={ux} active={false} narration={narrationOf?.(c.items[0].id)} />
              {c.message && <BlockItem item={c.message} cwd={cwd} threadId={threadId} />}
            </Fragment>
          ))}
        </div>
      </Collapse>
    </div>
  );
}, samePollRow);

/** The turn makes its narration lookup anew on every delta: what it answers for each check is what counts. */
function samePollRow(a: PollRowProps, b: PollRowProps) {
  return (
    a.cwd === b.cwd &&
    a.ux === b.ux &&
    a.threadId === b.threadId &&
    samePoll(a.block, b.block) &&
    a.block.checks.every((c) => sameNarration(a.narrationOf?.(c.items[0].id), b.narrationOf?.(c.items[0].id)))
  );
}
