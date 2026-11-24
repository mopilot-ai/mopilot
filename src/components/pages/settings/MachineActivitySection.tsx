// A machine page's Activity: the last 50 audit lines the Host keeps, in plain words ("Rules changed", "Phone removed: Pocket iPhone") with who did it where the Host says, repeats within a minute as one row ("Rules changed · 5 times"), and Export, which saves the raw lines as text.
import type { MachineAuditLine } from '../../../lib/machinePageData';
import { Group, Row } from './Controls';

const stamp = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** What each audit kind says in words; a kind this app does not know shows as the Host named it. */
const WORDS: Record<string, string> = {
  'chat.started': 'Chat started',
  'chat.message': 'Message sent',
  'approval.asked': 'Approval asked',
  'approval.answered': 'Approval answered',
  'approval.expired': 'Approval expired',
  'permission.set': 'Permission mode set',
  'tool.relayed': 'App tool used',
  'credential.lent': 'Credential lent',
  'credential.expired': 'Credential expired',
  'policy.changed': 'Rules changed',
  'schedule.run': 'Scheduled run',
  'git.write': 'Folder changed',
  'controller.connected': 'Mac connected by code',
  'client.refused': 'Request refused',
};
/** Where a line came from when the Host names no one, only the kind of client. */
const FROM: Record<string, string> = {
  desktop: 'from a computer',
  phone: 'from a phone',
  cli: 'from this machine’s command line',
  controller: 'from a Mac paired by code',
};
/** Repeats this close together are one row. */
const SAME_MINUTE_MS = 60_000;

/** A line in words: a client added or removed names the device (the Host records the client itself as who), any other line says who did it. @param {MachineAuditLine} l */
export function activityWords(l: MachineAuditLine): { title: string; who: string } {
  const change = l.kind === 'client.added' ? 'added' : l.kind === 'client.removed' ? 'removed' : null;
  if (!change) return { title: WORDS[l.kind] ?? l.kind, who: l.who || FROM[l.whoKind ?? ''] || '' };
  const what = l.whoKind === 'phone' ? 'Phone' : 'Device';
  return { title: l.who ? `${what} ${change}: ${l.who}` : `${what} ${change}`, who: '' };
}

/** The lines (newest first) as rows: neighbours that say the same thing within a minute of each other are one, with how many. */
export function collapseActivity(
  lines: readonly MachineAuditLine[],
): { key: string; title: string; who: string; at: number; count: number }[] {
  const rows: { key: string; title: string; who: string; at: number; count: number; last: number }[] = [];
  for (const l of lines) {
    const { title, who } = activityWords(l);
    const prev = rows.at(-1);
    if (prev && prev.title === title && prev.who === who && prev.last - l.at <= SAME_MINUTE_MS) {
      prev.count += 1;
      prev.last = l.at;
    } else rows.push({ key: `${l.at}-${l.kind}-${who}-${rows.length}`, title, who, at: l.at, count: 1, last: l.at });
  }
  return rows;
}

/** The lines as saved by Export: the Host's own words, one per line, oldest last as shown. */
export const exportText = (lines: readonly MachineAuditLine[]): string =>
  lines.map((l) => `${new Date(l.at).toISOString()}\t${l.kind}\t${l.who}`).join('\n');

export function MachineActivitySection({ name, lines }: { name: string; lines: MachineAuditLine[] }) {
  const save = () => {
    const url = URL.createObjectURL(new Blob([exportText(lines)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-activity.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Group
      title="Activity"
      action={
        <button className="btn-pill soft small" onClick={save}>
          Export
        </button>
      }
    >
      {collapseActivity(lines).map((r) => (
        <Row
          key={r.key}
          title={r.count > 1 ? `${r.title} · ${r.count} times` : r.title}
          desc={`${stamp(r.at)}${r.who ? ` · ${r.who}` : ''}`}
        />
      ))}
    </Group>
  );
}
