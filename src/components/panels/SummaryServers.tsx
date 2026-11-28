// The session rail's Servers section, as Claude Desktop's: the dev servers this chat started (browser_preview_start, any
// harness), four before "Show more", each opening its page in the browser pane, with a Stop button.
import { useEffect, useMemo, useReducer, useState } from 'react';
import { noteIgnored } from '../../lib/ignored';
import { native } from '../../lib/native';
import type { PreviewServer } from '../../lib/native/previews';
import { toastFailure, useStore } from '../../store/core';
import { openPaneTab } from '../../store/panes';
import { Server, Square, X } from '../ui/icons';
import { RailSection } from './RailSection';

/** Rows shown before "Show more". */
const SERVERS_SHOWN = 4;

const nameOf = (s: PreviewServer) => s.name ?? (s.port ? `localhost:${s.port}` : s.id);

/** What the row says at its end: starting, failed, or the port when the name doesn't already say it. */
function trailing(s: PreviewServer): { text: string; danger?: boolean } | null {
  if (s.status === 'starting') return { text: 'Starting…' };
  if (s.status === 'failed') return { text: 'Failed to start', danger: true };
  if (s.port && s.name) return { text: `:${s.port}` };
  return null;
}

export function SummaryServers({ threadId }: { threadId: string }) {
  const turnCount = useStore((s) => s.runtime[threadId]?.turns.length ?? 0);
  const turnStatus = useStore((s) => s.runtime[threadId]?.turns.at(-1)?.status);
  const [version, reread] = useReducer((n: number) => n + 1, 0);
  const [answer, setAnswer] = useState<{ chatId: string; servers: PreviewServer[] }>({ chatId: threadId, servers: [] });
  const [all, setAll] = useState(false);
  // a stop still on its way: its button waits, so a second click doesn't ask about a server already gone
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => native.previews.onChanged((e) => e?.chatId === threadId && reread()), [threadId]);
  // read again for each turn's start and end, and when main says the chat's servers changed
  const request = useMemo(() => ({ threadId, turnCount, turnStatus, version }), [threadId, turnCount, turnStatus, version]);
  useEffect(() => {
    let current = true;
    const chatId = request.threadId;
    native.previews.list(chatId).then(
      (servers) => current && setAnswer({ chatId, servers: Array.isArray(servers) ? servers : [] }),
      (error) => noteIgnored("read a chat's dev servers", error),
    );
    return () => {
      current = false;
    };
  }, [request]);
  // what ended on its own (exited, stopped) is gone from the list; one that failed stays to say so
  const servers = answer.chatId === threadId ? answer.servers.filter((s) => s.live || s.status === 'failed') : [];
  const running = servers.filter((s) => s.live).length;
  if (!servers.length) return null;
  const shown = all ? servers : servers.slice(0, SERVERS_SHOWN);
  const stop = (s: PreviewServer) => {
    setStopping((was) => new Set(was).add(s.id));
    native.previews
      .stop(threadId, s.id)
      .then(reread)
      .catch(toastFailure(`Couldn't ${s.live ? 'stop' : 'dismiss'} ${nameOf(s)}`))
      .finally(() =>
        setStopping((was) => {
          const next = new Set(was);
          next.delete(s.id);
          return next;
        }),
      );
  };
  return (
    <RailSection chatId={threadId} id="servers" className="summary-servers" summary={`${running} running`}>
      {shown.map((s) => {
        const end = trailing(s);
        const page = s.status === 'ready' && s.url;
        const label = (
          <>
            <Server size={15} aria-hidden="true" />
            <span className="summary-label">{nameOf(s)}</span>
            {end && <span className={end.danger ? 'summary-hint danger' : 'summary-hint'}>{end.text}</span>}
          </>
        );
        return (
          <div key={s.id} className="summary-task">
            {/* only a ready server has a page to open; the others are rows to read, not buttons to skip */}
            {page ? (
              <button
                type="button"
                className="summary-row"
                title={`Open ${nameOf(s)} in Browser`}
                onClick={() => openPaneTab('browser', { url: page, ownerChat: threadId, title: nameOf(s) })}
              >
                {label}
              </button>
            ) : (
              <div className="summary-row static" title={nameOf(s)}>
                {label}
              </div>
            )}
            {/* a failed one stays to say so until it is dismissed */}
            <button
              type="button"
              className="icon-btn xs summary-task-stop"
              title={s.live ? 'Stop this server' : 'Dismiss'}
              aria-label={`${s.live ? 'Stop' : 'Dismiss'} ${nameOf(s)}`}
              disabled={stopping.has(s.id)}
              onClick={() => stop(s)}
            >
              {s.live ? <Square size={12} /> : <X size={12} />}
            </button>
          </div>
        );
      })}
      {servers.length > SERVERS_SHOWN && (
        <button type="button" className="summary-row muted" aria-expanded={all} onClick={() => setAll(!all)}>
          <span className="summary-label">{all ? 'Show less' : 'Show more'}</span>
        </button>
      )}
    </RailSection>
  );
}
