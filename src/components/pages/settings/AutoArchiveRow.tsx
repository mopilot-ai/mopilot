// Settings → General → Automatically archive inactive chats (#1367): Never, or a number of days; main does the archiving.
import { Row, Select } from './Controls';
import { useStore, setPrefs } from '../../../store/core';
import { AUTO_ARCHIVE_DAYS, autoArchiveDays } from '../../../../shared/autoArchive.mjs';

const OPTIONS = [{ value: 'never', label: 'Never' }, ...AUTO_ARCHIVE_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))];

export function AutoArchiveRow() {
  const days = useStore((s) => autoArchiveDays(s.prefs));
  return (
    <Row
      title="Automatically archive inactive chats"
      desc="Archive chats after a period of inactivity. Pinned chats and chats that are working, waiting for you or scheduled are kept."
    >
      <Select
        value={days === null ? 'never' : String(days)}
        options={OPTIONS}
        onChange={(v) => setPrefs({ autoArchiveDays: v === 'never' ? null : Number(v) })}
      />
    </Row>
  );
}
