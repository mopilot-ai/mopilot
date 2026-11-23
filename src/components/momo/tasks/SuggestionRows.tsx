// The suggestion rows of the Tasks panel's Up next (A7): "From your sources" (what MoMo suggested: title, one source line, Start, Add, Hide, and Why? with the reason, the first step and what the ranking used) and "Added by you" (suggestions the user kept as their own tasks: Start, Hide). At most `shown` new ones are drawn, the rest behind "Show n more". Only the user's press starts anything. An added row slides up into its group once (motion, design 6), and not at all under Reduce Motion.
import { useState } from 'react';
import type { MomoSuggestion, MomoSuggestionAction } from '../../../lib/native/contracts/momoSuggestions';
import { Group, Row } from '../../pages/settings/Controls';
import { scoreLine } from './taskCopy';
import styles from './tasksPanel.module.css';

function SuggestionRow({
  s,
  fresh,
  act,
}: {
  s: MomoSuggestion;
  fresh: boolean;
  act: (id: string, action: MomoSuggestionAction) => unknown;
}) {
  const [why, setWhy] = useState(false);
  return (
    <div className={`momo-fact ${fresh ? styles.slideUp : ''}`} data-suggestion={s.id} data-status={s.status}>
      <Row title={s.title} desc={s.source}>
        <button className="btn-pill" onClick={() => void act(s.id, 'start')} aria-label={`Start ${s.title}`}>
          Start
        </button>
        {s.status === 'new' && (
          <button className="btn-pill soft" onClick={() => void act(s.id, 'add')} aria-label={`Add ${s.title}`}>
            Add
          </button>
        )}
        <button className="btn-pill soft" onClick={() => void act(s.id, 'hide')} aria-label={`Hide ${s.title}`}>
          Hide
        </button>
        <button className="btn-pill soft" aria-expanded={why} aria-label={`Why ${s.title}`} onClick={() => setWhy(!why)}>
          Why?
        </button>
      </Row>
      {why && (
        <div className={styles.why} data-suggestion-why>
          <div>{s.why}</div>
          <div>First step: {s.step}</div>
          <div>{scoreLine(s)}</div>
        </div>
      )}
    </div>
  );
}

export function SuggestionRows({
  suggestions,
  shown,
  fresh,
  act,
}: {
  suggestions: MomoSuggestion[];
  shown: number;
  fresh: ReadonlySet<string>;
  act: (id: string, action: MomoSuggestionAction) => unknown;
}) {
  const [all, setAll] = useState(false);
  const added = suggestions.filter((s) => s.status === 'added');
  const fromSources = suggestions.filter((s) => s.status === 'new');
  const visible = all ? fromSources : fromSources.slice(0, shown);
  const more = fromSources.length - visible.length;
  const rows = (list: MomoSuggestion[]) => list.map((s) => <SuggestionRow key={s.id} s={s} fresh={fresh.has(s.id)} act={act} />);
  return (
    <>
      {visible.length > 0 && (
        <Group
          title="From your sources"
          action={
            more > 0 && (
              <button className="btn-pill soft" onClick={() => setAll(true)}>
                {`Show ${more} more`}
              </button>
            )
          }
        >
          {rows(visible)}
        </Group>
      )}
      {added.length > 0 && <Group title="Added by you">{rows(added)}</Group>}
    </>
  );
}
