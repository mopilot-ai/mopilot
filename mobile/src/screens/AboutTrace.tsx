// What Settings › About says of the last launches and chat opens: when each began, how long it took to reach the list or the rows, and the steps in between. Timings only.
import { useEffect, useState } from 'react';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { lineOf, loadTrace, type TraceRecord } from '../launchTrace';

/** `2.1 s` under ten seconds, whole seconds above, `0.4 s` for a few hundred ms; a record with no step has no time. */
export const took = (record: TraceRecord): string | undefined => {
  const ms = record.steps.at(-1)?.[1];
  if (ms === undefined) return undefined;
  return `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;
};

const when = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function AboutTrace() {
  const [records, setRecords] = useState<TraceRecord[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadTrace().then((all) => live && setRecords(all));
    return () => {
      live = false;
    };
  }, []);
  if (!records) return null;
  const section = (kind: TraceRecord['kind'], title: string, empty: string) => {
    const mine = records.filter((r) => r.kind === kind);
    return (
      <>
        <GroupLabel>{title}</GroupLabel>
        {mine.length ? (
          <Group>
            {mine.map((r) => (
              <GroupItem key={`${r.kind}${r.id}`} title={when(r.at)} value={took(r)} detail={lineOf(r)} />
            ))}
          </Group>
        ) : (
          <GroupLabel>{empty}</GroupLabel>
        )}
      </>
    );
  };
  return (
    <>
      {section('launch', 'Last launches (ms after the app started)', 'No launch recorded yet.')}
      {section('chat', 'Last chat opens (ms after the tap)', 'No chat opened yet.')}
      {section('send', 'Last sends (ms after Send)', 'No message sent yet.')}
    </>
  );
}
