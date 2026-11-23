// Settings sections that belong to one harness. Settings.tsx renders this and never names a harness.
import { HARNESS_IDS } from '../../harness/types';
import { CodexPage } from './codex/Page';
import { ClaudePage } from './claude/Page';

export function HarnessSection({ section, tab }: { section: string; tab?: string }) {
  if (section === 'codex') return <CodexPage key={tab ?? 'overview'} tab={tab} />;
  if (section === 'claude') return <ClaudePage key={tab ?? 'overview'} tab={tab} />;
  return null;
}

/** A harness's own page, whose header gives its title (Settings shows no title of its own above it). */
export const hasOwnHeader = (section: string) => (HARNESS_IDS as readonly string[]).includes(section);
