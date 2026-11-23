// The Claude Code MCP add form: validate and preview the command before writing user configuration.
import { useEffect, useRef, useState } from 'react';
import { toast } from '../../../store/core';
import { native, type ClaudeApiKeyInfo } from '../../../lib/native';
import { claudeMcpAddArgv, claudeMcpProblem, shellLine, type ClaudeMcpForm } from '../../../lib/mcpConfig';
import { Select } from '../../pages/Settings';
import { Spinner } from '../../ui/icons';
import { errorText } from '../../../lib/ignored';

const EMPTY: ClaudeMcpForm = { name: '', type: 'stdio', command: '', args: [], url: '', env: [], headers: [] };
const lines = (text: string, sep: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(sep);
      return i < 0 ? { key: l, value: '' } : { key: l.slice(0, i).trim(), value: l.slice(i + sep.length).trim() };
    });

/** The add-a-server form: the command it will run is shown, and runs only on the button. */
export function AddMcp({
  bin,
  account,
  mode,
  onDone,
}: {
  bin: string;
  account: string;
  mode: ClaudeApiKeyInfo['mode'];
  onDone: () => void;
}) {
  const [f, setF] = useState<ClaudeMcpForm>(EMPTY);
  const [argText, setArgText] = useState('');
  const [envText, setEnvText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<object | null>(null);
  useEffect(
    () => () => {
      pending.current = null;
    },
    [],
  );
  const form: ClaudeMcpForm = {
    ...f,
    args: argText.split(/\s+/).filter(Boolean),
    env: lines(envText, '='),
    headers: lines(headerText, ':'),
  };
  const problem = claudeMcpProblem(form);
  const argv = claudeMcpAddArgv('claude', form);
  const run = async () => {
    if (pending.current) return;
    const owner = {};
    pending.current = owner;
    setBusy(true);
    try {
      const out = await native.claude.mcp(bin, argv.slice(1), account, undefined, mode);
      if (pending.current !== owner) return;
      toast(out.split('\n')[0] || `Added ${form.name.trim()}`);
      onDone();
    } catch (e) {
      if (pending.current === owner) toast(errorText(e), 'error');
    } finally {
      if (pending.current === owner) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <div className="settings-pad mcp-form">
      <label className="hs-field">
        <span className="hs-field-label">Name</span>
        <input
          className="text-input slim wide"
          aria-label="MCP server name"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          placeholder="github"
        />
      </label>
      <div className="hs-field">
        <span className="hs-field-label">Type</span>
        <Select
          value={f.type}
          width={160}
          options={[
            { value: 'stdio', label: 'Command (stdio)' },
            { value: 'http', label: 'HTTP' },
            { value: 'sse', label: 'SSE' },
          ]}
          onChange={(type) => setF({ ...f, type })}
        />
      </div>
      {f.type === 'stdio' ? (
        <>
          <label className="hs-field">
            <span className="hs-field-label">Command</span>
            <input
              className="text-input slim wide"
              aria-label="MCP command"
              value={f.command}
              onChange={(e) => setF({ ...f, command: e.target.value })}
              placeholder="npx"
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Arguments</span>
            <input
              className="text-input slim wide"
              aria-label="MCP arguments"
              value={argText}
              onChange={(e) => setArgText(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-github"
            />
          </label>
        </>
      ) : (
        <>
          <label className="hs-field">
            <span className="hs-field-label">URL</span>
            <input
              className="text-input slim wide"
              aria-label="MCP URL"
              value={f.url}
              onChange={(e) => setF({ ...f, url: e.target.value })}
              placeholder="https://example.com/mcp"
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">
              Headers <span className="hs-field-opt">one per line, Name: value</span>
            </span>
            <textarea className="text-area" rows={2} value={headerText} onChange={(e) => setHeaderText(e.target.value)} />
          </label>
        </>
      )}
      <label className="hs-field">
        <span className="hs-field-label">
          Environment <span className="hs-field-opt">one per line, KEY=value</span>
        </span>
        <textarea className="text-area" rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} />
      </label>
      <div className="hs-field">
        <span className="hs-field-label">Command that will run</span>
        <pre className="mcp-preview" aria-label="Command preview">
          {problem ? `# ${problem}` : shellLine(argv)}
        </pre>
        <span className="hs-field-hint">Added for you in every project (--scope user). Nothing runs until you press Add server.</span>
      </div>
      <div className="settings-actions">
        <button className="btn primary sm" disabled={!!problem || busy} onClick={run}>
          {busy ? <Spinner size={12} /> : 'Add server'}
        </button>
        <button className="btn sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
