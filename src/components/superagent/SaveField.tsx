// Settings › Superagent: a text field with a Save button, for a value that is checked in main (the repository, the allowed logins): it shows the saved value until the person edits it, and what was refused stays typed.
import { useEffect, useState } from 'react';
import { isEnter } from '../../lib/focus';

export function SaveField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  /** resolves whether it was saved; a refusal has already been told */
  onSave: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  // saved, so the field shows what is saved (main may have cleaned the text into the value it already had)
  const [saved, setSaved] = useState(0);
  // a change saved elsewhere (another window) shows here too
  // biome-ignore lint/correctness/useExhaustiveDependencies: `saved` re-runs it after a save even when the value did not change
  useEffect(() => setDraft(value), [value, saved]);
  const save = async () => {
    if (busy || draft === value) return;
    setBusy(true);
    if (await onSave(draft)) setSaved((n) => n + 1);
    setBusy(false);
  };
  return (
    <>
      <input
        className="text-input slim wide"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => isEnter(e) && void save()}
      />
      <button className="btn-pill" disabled={busy || draft === value} onClick={() => void save()}>
        Save
      </button>
    </>
  );
}
