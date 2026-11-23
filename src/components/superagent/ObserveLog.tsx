// Settings › Superagent › 3. Read what it would have done: the observe log, each entry with what the Gate decided and why, marked Right or Wrong so "would accept" can be measured.
import { native } from '../../lib/native';
import type { SuperagentLogRow, SuperagentStats } from '../../lib/native/superagent';
import { Group, Row, Segmented } from '../pages/settings/Controls';
import { precisionText } from './model';

const MARKS = [
  { value: 'right' as const, label: 'Right' },
  { value: 'wrong' as const, label: 'Wrong' },
];

export function ObserveLog({
  log,
  stats,
  change,
}: {
  log: SuperagentLogRow[];
  stats: SuperagentStats;
  change: (run: () => Promise<unknown>) => Promise<boolean>;
}) {
  return (
    <Group
      title="3. Read what it would have done"
      desc="Nothing below was acted on. Mark the wrong ones, then turn a rule to Auto when you trust it."
    >
      <Row title="Precision" desc={precisionText(stats)} />
      {log.length === 0 && <Row title="Nothing yet" desc="Events appear here as they arrive." />}
      {log.map((row) => (
        <Row key={row.id} title={row.verdict} desc={`${row.what}. ${row.reasonText}.`}>
          <Segmented<'right' | 'wrong'>
            label={`Mark: ${row.what}`}
            value={row.mark ?? ('' as 'right')}
            options={MARKS}
            // marking the one that is marked takes the mark back
            onChange={(v) => void change(() => native.superagent.mark(row.id, v === row.mark ? null : v))}
          />
        </Row>
      ))}
    </Group>
  );
}
