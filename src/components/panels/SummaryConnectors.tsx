// The session rail's Connectors card: the chat's connector inventory on its current harness, collapsed to a summary.
import { useEffect, useMemo, useReducer, useState } from 'react';
import { useWindowListener } from '../../lib/effects';
import { noteIgnored } from '../../lib/ignored';
import { loadSessionConnectors, useConnectorSession, watchSessionConnectors, type ConnectorInventory } from '../../session/harness/mcpRows';
import { heldReconnects, type HeldReconnects } from '../../session/harness/connectorActions';
import { useStore } from '../../store/core';
import { navigate } from '../../store/panes';
import { SummaryConnectorRows } from './SummaryConnectorRows';
import { RailSection } from './RailSection';

type Location = 'local' | 'remote' | 'pending' | 'workspaceUnavailable';
type Result = (ConnectorInventory & { held?: HeldReconnects }) | { scope: 'loading' | 'failed' | 'remote' };
const NONE_HELD: HeldReconnects = { waiting: [], reconnecting: [] };
const CONNECTOR_WAIT_MS = 12_000;

/** Whether two reads ask about the same session's connectors, differing only in when (turn, refresh) they were asked. */
const sameSession = <T extends Record<string, unknown>>(a: T, b: T) =>
  Object.keys(a).every((k) => k === 'turnCount' || k === 'turnStatus' || k === 'refreshCount' || a[k] === b[k]);

export function SummaryConnectors({ chatId, cwd, location }: { chatId: string; cwd: string; location: Location }) {
  const { nativeId, family, account, connection, choice, settings } = useConnectorSession(chatId);
  const turnCount = useStore((s) => s.runtime[chatId]?.turns.length);
  const turnStatus = useStore((s) => s.runtime[chatId]?.turns.at(-1)?.status);
  const [refreshCount, refresh] = useReducer((count: number) => count + 1, 0);
  const request = useMemo(
    () => ({ chatId, nativeId, family, location, cwd, account, connection, choice, turnCount, turnStatus, refreshCount }),
    [chatId, nativeId, family, location, cwd, account, connection, choice, turnCount, turnStatus, refreshCount],
  );
  const [answer, setAnswer] = useState<{ request: typeof request; result: Result }>();

  useWindowListener('focus', () => {
    if (location === 'local') refresh();
  });
  useEffect(() => {
    if (request.location !== 'local') return;
    const publish = (result: Result) => setAnswer({ request, result });
    let cancelRead: (() => void) | undefined;
    const read = () => {
      const attempt = new AbortController();
      const finish = (result: Result) => {
        if (!attempt.signal.aborted) publish(result);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        finish({ scope: 'failed' });
        attempt.abort();
      }, CONNECTOR_WAIT_MS);
      cancelRead = () => {
        clearTimeout(timer);
        attempt.abort();
      };
      // a reconnect waiting for the turn is said on its row; not knowing which is not a failed read
      const waiting = (found: ConnectorInventory) =>
        found.scope !== 'unavailable' && found.rows.some((row) => row.state === 'attention')
          ? heldReconnects(request.family, request.nativeId).then(
              (held) => ({ ...found, held }),
              (error) => {
                noteIgnored("read a chat's connector reconnects waiting for its turn", error);
                return found;
              },
            )
          : found;
      void loadSessionConnectors(request.family, request.chatId, request.nativeId, attempt.signal)
        .then(waiting)
        .then(finish, (error) => {
          if (attempt.signal.aborted) return;
          noteIgnored("read the chat's connector status", error);
          finish({ scope: 'failed' });
        });
    };
    const unwatch = watchSessionConnectors(request.family, request.nativeId, (closed) => {
      cancelRead?.();
      publish({ scope: closed ? 'unavailable' : 'loading' });
      if (!closed) read();
    });
    read();
    return () => {
      unwatch?.();
      cancelRead?.();
    };
  }, [request]);

  const result: Result =
    location === 'remote'
      ? { scope: 'remote' }
      : location === 'workspaceUnavailable'
        ? { scope: 'unavailable' }
        : answer?.request === request
          ? answer.result
          : // a turn or a refresh re-reads the same session's list: keep showing the last one meanwhile, so the card
            // (absent when there are none) doesn't flash in and out on every turn
            answer && sameSession(answer.request, request) && answer.result.scope !== 'failed' && answer.result.scope !== 'loading'
            ? answer.result
            : { scope: 'loading' };
  const inventory = result.scope === 'session' || result.scope === 'configuration' ? result : null;
  const rows = inventory?.rows ?? [];
  const reconnect = rows.filter((row) => row.state === 'attention').length;
  const connected = rows.filter((row) => row.state === 'connected' || row.state === 'pending').length;
  const hint = reconnect
    ? `${reconnect} to reconnect`
    : {
        session: `${connected} connected`,
        configuration: `${rows.filter((row) => row.state === 'configured').length} configured`,
        loading: 'Reading…',
        failed: 'Unavailable',
        remote: 'On Host',
        unavailable: 'Unavailable',
      }[result.scope];
  const message = {
    session: '',
    configuration: 'Showing global settings. Live connection status is unavailable.',
    loading: location === 'pending' ? 'Locating workspace…' : 'Reading connector status…',
    failed: 'Could not read connector status.',
    remote: 'Manage connectors on the computer running this chat.',
    unavailable:
      location === 'workspaceUnavailable'
        ? 'Could not confirm which computer runs this chat.'
        : 'This session has no connector status available.',
  }[result.scope];

  // as Claude Desktop's, a session with no connectors has no card
  if (inventory && !rows.length) return null;
  return (
    <RailSection chatId={chatId} id="connectors" className="summary-connectors" summary={hint}>
      {(open) => (
        <>
          {open && message && (
            <p className="summary-context-detail" role="status">
              {message}
            </p>
          )}
          {/* mounted through a re-read and a fold, so a row's sign-in and the held order outlive them; a new session starts fresh */}
          <SummaryConnectorRows
            key={`${family}:${nativeId}`}
            chatId={chatId}
            family={family}
            nativeId={nativeId}
            rows={rows}
            held={inventory?.held ?? NONE_HELD}
            manage={() => navigate(settings)}
            refresh={refresh}
          />
          {open && location === 'local' && (
            <div className="summary-connector-actions">
              {result.scope === 'failed' && (
                <button type="button" className="link-btn" onClick={refresh}>
                  Retry
                </button>
              )}
              <button type="button" className="link-btn" onClick={() => navigate(settings)}>
                Manage connectors
              </button>
            </div>
          )}
        </>
      )}
    </RailSection>
  );
}
