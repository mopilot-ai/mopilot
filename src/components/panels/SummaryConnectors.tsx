// Connector inventory and recovery for the active chat's session rail.
import { useEffect, useMemo, useReducer, useState } from 'react';
import { useWindowListener } from '../../lib/effects';
import { noteIgnored } from '../../lib/ignored';
import { withKeys } from '../../lib/listKeys';
import { loadSessionConnectors, useConnectorSession, watchSessionConnectors, type ConnectorInventory } from '../../session/harness/mcpRows';
import { useStore } from '../../store/core';
import { navigate } from '../../store/panes';
import { ChevronRight, Plug } from '../ui/icons';

type Location = 'local' | 'remote' | 'pending' | 'workspaceUnavailable';
type Result = ConnectorInventory | { scope: 'loading' | 'failed' | 'remote' };
const CONNECTOR_WAIT_MS = 12_000;

export function SummaryConnectors({ chatId, cwd, location }: { chatId: string; cwd: string; location: Location }) {
  const { nativeId, family, account, connection, choice, settings } = useConnectorSession(chatId);
  const turnCount = useStore((s) => s.runtime[chatId]?.turns.length);
  const turnStatus = useStore((s) => s.runtime[chatId]?.turns.at(-1)?.status);
  const [refreshCount, refresh] = useReducer((count: number) => count + 1, 0);
  const [open, setOpen] = useState(false);
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
      void loadSessionConnectors(request.family, request.chatId, request.nativeId, attempt.signal).then(finish, (error) => {
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
          : { scope: 'loading' };
  const inventory = result.scope === 'session' || result.scope === 'configuration' ? result : null;
  const reconnect = inventory?.rows.filter((row) => row.reconnect).length ?? 0;
  const hint = reconnect
    ? `${reconnect} to reconnect`
    : {
        session: inventory?.rows.length ? '' : 'None',
        configuration: 'Configuration only',
        loading: 'Reading…',
        failed: 'Unavailable',
        remote: 'On Host',
        unavailable: 'Unavailable',
      }[result.scope];
  const message = {
    session: inventory?.rows.length ? '' : 'No MCP connectors in this session.',
    configuration: 'Showing global settings. Live connection status is unavailable.',
    loading: location === 'pending' ? 'Locating workspace…' : 'Reading connector status…',
    failed: 'Could not read connector status.',
    remote: 'Manage connectors on the computer running this chat.',
    unavailable:
      location === 'workspaceUnavailable'
        ? 'Could not confirm which computer runs this chat.'
        : 'This session has no connector status available.',
  }[result.scope];

  return (
    <details className="summary-card summary-connectors" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="summary-card-toggle">
        <span>Connectors</span>
        <ChevronRight className="summary-disclosure-arrow" size={13} aria-hidden="true" />
        <span className="summary-connector-hint">{hint}</span>
      </summary>
      <div className="summary-group">
        {open && (
          <>
            {message && (
              <p className="summary-context-detail" role="status">
                {message}
              </p>
            )}
            {withKeys(inventory?.rows ?? [], (row) => row.name).map(({ key, item }) => (
              <div className="summary-row static summary-connector" key={key}>
                <Plug size={14} aria-hidden="true" />
                <span className="summary-label" title={item.name}>
                  {item.name}
                </span>
                <span className="summary-hint">{item.status}</span>
              </div>
            ))}
            {location === 'local' && (
              <div className="summary-connector-actions">
                {result.scope !== 'loading' && (
                  <button type="button" className="link-btn" onClick={refresh}>
                    {result.scope === 'failed' ? 'Retry' : 'Refresh'}
                  </button>
                )}
                <button type="button" className="link-btn" onClick={() => navigate(settings)}>
                  Manage connectors
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
