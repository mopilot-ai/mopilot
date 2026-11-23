// The line under a harness's version when the user's terminal runs a different CLI than MoPilot, or none:
// a CLI found in a folder only MoPilot looks in reads as made up unless it says where it came from.
import { offPathNote, type OffPathFields } from '../../lib/cliSource';

export function OffPathNote({
  name,
  bin,
  where,
}: {
  name: string;
  bin: string | null | undefined;
  where: OffPathFields | null | undefined;
}) {
  const note = offPathNote(name, bin, where);
  if (!note) return null;
  return (
    <span className="cli-offpath" title={note.title}>
      {note.text}
    </span>
  );
}
