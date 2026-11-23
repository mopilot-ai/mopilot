// MCP server lists and OAuth registration/sign-in controls.
import { toast } from '../../../../store/core';
import { codexRequest } from '../../../../harness/adapters/codex';
import { errorText } from '../../../../lib/ignored';
import { Group, Toggle } from '../../../pages/settings/Controls';
import type { McpServerStatus } from '../../../../protocol/v2/McpServerStatus';
import { Settings as Gear, Spinner } from '../../../ui/icons';
import { reloadMcpServers, type McpServerToml } from './data';
import { McpAuth } from './McpAuth';

/* ------------------------------------------------------------------ */
/* MCP servers                                                         */
/* ------------------------------------------------------------------ */
export function McpList({
  status,
  servers,
  error,
  match,
  onEdit,
  onChange,
}: {
  status: McpServerStatus[] | null;
  servers: Record<string, McpServerToml>;
  error?: string | null;
  match: (...x: string[]) => boolean;
  onEdit: (name: string) => void;
  /** reads the list again; the switches wait for it */
  onChange: () => unknown;
}) {
  if (!status)
    return (
      <div className="ps-loading">
        <Spinner size={16} />
      </div>
    );
  const own = Object.keys(servers)
    .filter((n) => match(n))
    .sort((a, b) => a.localeCompare(b));
  // Everything the config doesn't define (plugin servers, plus the built-in codex_apps connector).
  const fromPlugins = status.filter((s) => !servers[s.name] && match(s.name)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="ps-mcp">
      {error && <div className="ps-empty">Couldn't read the MCP servers: {error}</div>}
      <Group title="Servers">
        {own.length === 0 && <div className="settings-pad settings-row-desc">No MCP servers configured</div>}
        {own.map((n) => (
          <div key={n} className="settings-row ps-mcp-row">
            <span className="ps-mcp-name">{n}</span>
            <span className="ps-mcp-controls">
              {servers[n]?.url &&
                (status.find((x) => x.name === n)?.authStatus === 'notLoggedIn' ||
                  status.find((x) => x.name === n)?.authStatus === 'oAuth') && (
                  <McpAuth name={n} signedIn={status.find((x) => x.name === n)?.authStatus === 'oAuth'} onDone={onChange} />
                )}
              <button className="ps-icon-btn" onClick={() => onEdit(n)} aria-label="Settings">
                <Gear size={16} strokeWidth={1.6} />
              </button>
              <Toggle
                on={servers[n]?.enabled !== false}
                onChange={async (v) => {
                  try {
                    await codexRequest('config/value/write', {
                      keyPath: `mcp_servers.${JSON.stringify(n)}.enabled`,
                      value: v,
                      mergeStrategy: 'replace',
                    });
                    await reloadMcpServers();
                    // the switch stays pending until the list is read again, so a second click flips what it shows
                    await onChange();
                  } catch (e) {
                    toast(errorText(e), 'error');
                  }
                }}
              />
            </span>
          </div>
        ))}
      </Group>
      {fromPlugins.length > 0 && (
        <Group title="From plugins">
          {fromPlugins.map((s) => (
            <div key={s.name} className="settings-row ps-mcp-row">
              <span className="ps-mcp-name">{s.name}</span>
              {(s.authStatus === 'notLoggedIn' || s.authStatus === 'oAuth') && (
                <McpAuth name={s.name} signedIn={s.authStatus === 'oAuth'} onDone={onChange} />
              )}
            </div>
          ))}
        </Group>
      )}
    </div>
  );
}
