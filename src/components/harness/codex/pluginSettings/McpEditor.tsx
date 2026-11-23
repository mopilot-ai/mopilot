// Custom MCP server configuration editor with stable list and key/value field rows.
import { useState, type ReactNode } from 'react';
import { toast } from '../../../../store/core';
import { codexRequest } from '../../../../harness/adapters/codex';
import { errorText } from '../../../../lib/ignored';
import { useRowIds } from '../../../../lib/listKeys';
import { WebLink } from '../../../ui/WebLink';
import { mergeCodexMcp } from '../../../../lib/mcpConfig';
import { Trash2, ArrowLeft, ExternalLink, Plus } from '../../../ui/icons';
import { reloadMcpServers, type McpServerToml } from './data';
type KV = { key: string; value: string };
const toKV = (o: Record<string, string>): KV[] =>
  Object.entries(o).map(([key, value]) => ({
    key,
    value: String(value),
  }));
const fromKV = (l: KV[]) => Object.fromEntries(l.filter((x) => x.key.trim()).map((x) => [x.key.trim(), x.value]));

/** "Connect to a custom MCP" / "Update <name> MCP": edits an `[mcp_servers.<name>]` table. */
export function McpEditor({ name, config, onDone }: { name: string | null; config: McpServerToml | null; onDone: () => void }) {
  const isNew = name == null;
  const [serverName, setServerName] = useState(name ?? '');
  const [type, setType] = useState<'stdio' | 'http'>(config?.url ? 'http' : 'stdio');
  const [command, setCommand] = useState<string>(config?.command ?? '');
  const [args, setArgs] = useState<string[]>(config?.args?.length ? config.args.map(String) : ['']);
  const [env, setEnv] = useState<KV[]>(config?.env ? toKV(config.env) : [{ key: '', value: '' }]);
  const [envVars, setEnvVars] = useState<string[]>(config?.env_vars?.length ? config.env_vars.map(String) : ['']);
  const [cwd, setCwd] = useState<string>(config?.cwd ?? '');
  const [url, setUrl] = useState<string>(config?.url ?? '');
  const [bearer, setBearer] = useState<string>(config?.bearer_token_env_var ?? '');
  const [headers, setHeaders] = useState<KV[]>(config?.http_headers ? toKV(config.http_headers) : [{ key: '', value: '' }]);
  const [envHeaders, setEnvHeaders] = useState<KV[]>(config?.env_http_headers ? toKV(config.env_http_headers) : [{ key: '', value: '' }]);
  const [busy, setBusy] = useState(false);
  const valid = serverName.trim() && /^[\w-]+$/.test(serverName.trim()) && (type === 'stdio' ? command.trim() : url.trim());

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const edited: Record<string, unknown> =
      type === 'stdio'
        ? {
            command: command.trim(),
            args: args.map((a) => a.trim()).filter(Boolean),
            env: fromKV(env),
            env_vars: envVars.map((v) => v.trim()).filter(Boolean),
            ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          }
        : {
            url: url.trim(),
            ...(bearer.trim() ? { bearer_token_env_var: bearer.trim() } : {}),
            http_headers: fromKV(headers),
            env_http_headers: fromKV(envHeaders),
          };
    // empty tables and lists are dropped from the edit; keys the editor doesn't own stay as they were
    for (const k of Object.keys(edited))
      if (
        (edited[k] && typeof edited[k] === 'object' && !Array.isArray(edited[k]) && !Object.keys(edited[k]).length) ||
        (Array.isArray(edited[k]) && !edited[k].length)
      )
        delete edited[k];
    const value = mergeCodexMcp(config, edited);
    try {
      await codexRequest('config/value/write', {
        keyPath: `mcp_servers.${JSON.stringify(serverName.trim())}`,
        value,
        mergeStrategy: 'replace',
      });
      if (await reloadMcpServers()) toast(isNew ? `Added ${serverName.trim()}` : 'Saved');
      onDone();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };
  const uninstall = async () => {
    if (!name || !window.confirm(`Remove the ${name} MCP server from config.toml?`)) return;
    try {
      await codexRequest('config/value/write', {
        keyPath: `mcp_servers.${JSON.stringify(name)}`,
        value: null,
        mergeStrategy: 'replace',
      });
      await reloadMcpServers('Removed');
      onDone();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const pretty = name ? name.charAt(0).toUpperCase() + name.slice(1) : '';

  return (
    <div className="mcp-edit">
      <button className="ps-back" onClick={onDone}>
        <ArrowLeft size={15} strokeWidth={1.7} /> Back
      </button>
      <div className="mcp-edit-head">
        <h1 className="mcp-edit-title">{isNew ? 'Connect to a custom MCP' : `Update ${pretty} MCP`}</h1>
        {!isNew && (
          <button className="mcp-uninstall" onClick={uninstall}>
            <Trash2 size={15} strokeWidth={1.7} /> Uninstall
          </button>
        )}
      </div>
      {isNew ? (
        <WebLink className="mcp-docs" href="https://developers.openai.com/codex/mcp">
          Docs <ExternalLink size={12} strokeWidth={1.7} />
        </WebLink>
      ) : (
        <p className="mcp-note">If you would like to switch MCP server type, please uninstall first.</p>
      )}
      {isNew && (
        <div className="mcp-card">
          <Field label="Name">
            <input
              className="mcp-input"
              placeholder="MCP server name"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          </Field>
          <div className="mcp-type">
            <span>Type</span>
            <span className="ps-tabs">
              <button className={`ps-tab ${type === 'stdio' ? 'on' : ''}`} onClick={() => setType('stdio')}>
                STDIO
              </button>
              <button className={`ps-tab ${type === 'http' ? 'on' : ''}`} onClick={() => setType('http')}>
                Streamable HTTP
              </button>
            </span>
          </div>
        </div>
      )}
      <div className="mcp-card">
        {type === 'stdio' ? (
          <>
            <Field label="Command to launch">
              <input
                className="mcp-input"
                placeholder="openai-dev-mcp serve-sqlite"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <ListField label="Arguments" addLabel="Add argument" items={args} setItems={setArgs} />
            <KVField label="Environment variables" addLabel="Add environment variable" items={env} setItems={setEnv} />
            <ListField label="Environment variable passthrough" addLabel="Add variable" items={envVars} setItems={setEnvVars} />
            <Field label="Working directory">
              <input className="mcp-input" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <input
                className="mcp-input"
                placeholder="https://mcp.example.com/mcp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <Field label="Bearer token env var">
              <input
                className="mcp-input"
                placeholder="MCP_BEARER_TOKEN"
                value={bearer}
                onChange={(e) => setBearer(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <KVField label="Headers" addLabel="Add header" items={headers} setItems={setHeaders} />
            <KVField label="Headers from environment variables" addLabel="Add variable" items={envHeaders} setItems={setEnvHeaders} />
          </>
        )}
      </div>
      <div className="mcp-foot">
        <button className="ps-btn primary sm" disabled={!valid || busy} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mcp-field">
      <p>{label}</p>
      {children}
    </div>
  );
}
function ListField({
  label,
  addLabel,
  items,
  setItems,
}: {
  label: string;
  addLabel: string;
  items: string[];
  setItems: (v: string[]) => void;
}) {
  const rows = useRowIds(items.length);
  return (
    <div className="mcp-field list">
      <p>{label}</p>
      <div className="mcp-lines">
        {items.map((v, i) => (
          <div key={rows.ids[i]} className="mcp-line">
            <input
              className="mcp-input"
              value={v}
              onChange={(e) => setItems(items.map((x, j) => (j === i ? e.target.value : x)))}
              spellCheck={false}
            />
            <button
              className="ps-icon-btn sm"
              aria-label="Remove"
              disabled={items.length === 1 && !v}
              onClick={() => {
                if (items.length === 1) return setItems(['']);
                rows.remove(i);
                setItems(items.filter((_, j) => j !== i));
              }}
            >
              <Trash2 size={15} strokeWidth={1.6} />
            </button>
          </div>
        ))}
      </div>
      <button className="mcp-add" onClick={() => setItems([...items, ''])}>
        <Plus size={15} strokeWidth={1.7} /> {addLabel}
      </button>
    </div>
  );
}
function KVField({ label, addLabel, items, setItems }: { label: string; addLabel: string; items: KV[]; setItems: (v: KV[]) => void }) {
  const set = (i: number, patch: Partial<KV>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const rows = useRowIds(items.length);
  return (
    <div className="mcp-field list">
      <p>{label}</p>
      <div className="mcp-lines">
        {items.map((v, i) => (
          <div key={rows.ids[i]} className="mcp-line">
            <input
              className="mcp-input"
              placeholder="Key"
              value={v.key}
              onChange={(e) => set(i, { key: e.target.value })}
              spellCheck={false}
            />
            <input
              className="mcp-input"
              placeholder="Value"
              value={v.value}
              onChange={(e) => set(i, { value: e.target.value })}
              spellCheck={false}
            />
            <button
              className="ps-icon-btn sm"
              aria-label="Remove"
              disabled={items.length === 1 && !v.key && !v.value}
              onClick={() => {
                if (items.length === 1) return setItems([{ key: '', value: '' }]);
                rows.remove(i);
                setItems(items.filter((_, j) => j !== i));
              }}
            >
              <Trash2 size={15} strokeWidth={1.6} />
            </button>
          </div>
        ))}
      </div>
      <button className="mcp-add" onClick={() => setItems([...items, { key: '', value: '' }])}>
        <Plus size={15} strokeWidth={1.7} /> {addLabel}
      </button>
    </div>
  );
}
