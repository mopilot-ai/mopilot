// The session rail's context percentage and meter, opening into the detailed context panel.
import { contextLevel, contextShare, contextTokens } from '../../lib/contextFormat';
import { contextPercent } from '../../store/contextUsage';
import { useChatContext } from '../../session/useChatContext';
import { LazyContextPanel } from '../context/LazyContextPanel';
import { RailSection } from './RailSection';

export function SummaryContext({ threadId }: { threadId: string }) {
  const context = useChatContext(threadId, "read a chat's context use for its summary");
  const percent = context ? contextPercent(context) : null;
  return (
    <RailSection
      chatId={threadId}
      id="context"
      className="summary-context"
      // quiet while there is room, amber from 80%, red from 95%, as the composer's ring
      level={percent === null ? undefined : contextLevel(percent)}
      summary={
        <>
          <span
            className="summary-context-value"
            title={context ? `${contextTokens(context.used)} / ${contextTokens(context.window)} tokens` : undefined}
          >
            {context ? contextShare(context.used, context.window) : '—'}
          </span>
          {percent !== null && <meter aria-label="Context used" min={0} max={100} value={Math.min(percent, 100)} />}
        </>
      }
    >
      {/* the panel loads and reads only while the section is open */}
      {(open) => open && <LazyContextPanel threadId={threadId} />}
    </RailSection>
  );
}
