// The banner shown when the chat-data migration didn't finish, with retry and the report.

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { navigate } from '../../store/panes';
import { retryMigration } from '../../store/chats';
import { useStore } from '../../store/core';
import { SideBanner } from './SideBanner';

/** The chat-data migration didn't finish: the old files still serve every chat. Retry, or read the report. */
export function MigrationBanner() {
  const issue = useStore((s) => s.migrationIssue);
  const [busy, setBusy] = useState(false);
  if (!issue) return null;
  return (
    <SideBanner
      tone="warn"
      icon={<AlertTriangle size={16} />}
      title="Couldn't move archived chats"
      detail="Restored from backup."
      testId="migration-banner"
    >
      <button className="btn sm" onClick={() => navigate({ name: 'settings', section: 'about', tab: 'chat-data' })}>
        Report
      </button>
      <button
        className="btn primary sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await retryMigration();
          } finally {
            setBusy(false);
          }
        }}
      >
        Retry
      </button>
    </SideBanner>
  );
}
