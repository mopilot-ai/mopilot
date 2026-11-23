// Claude MCP settings: provenance-aware connection actions and a cancellable account-scoped sign-in terminal.
import { useEffect, useRef, useState } from 'react';
import { native, type PtySpawnOptions, type ClaudeApiKeyInfo } from '../../../lib/native';
import { useWindowListener } from '../../../lib/effects';
import { errorText } from '../../../lib/ignored';
import { shellLine } from '../../../lib/mcpConfig';
import { CLAUDE_CONNECTORS, claudeMcpCapabilities, mcpConnectionStatus, type ClaudeMcpServer } from '../../../harness/mcpConnection';
import { Group, Row } from '../../pages/Settings';
import { Plus } from '../../ui/icons';
import { TermView } from '../../panels/TerminalPanel';
import { AddMcp } from './ClaudeMcpAdd';

type Login = { name: string; id: string; options: PtySpawnOptions };

export function ClaudeMcp({
  bin,
  cwd,
  account,
  mode,
  servers,
  err,
  loaded,
  reload,
}: {
  bin: string;
  cwd: string;
  account: string;
  mode: ClaudeApiKeyInfo['mode'];
  servers: ClaudeMcpServer[];
  err: string | null;
  loaded: boolean;
  reload: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [external, setExternal] = useState(false);
  const operation = useRef<object | null>(null);
  useEffect(
    () => () => {
      operation.current = null;
    },
    [],
  );
  useWindowListener('focus', () => {
    if (external) reload();
  });

  const run = async (name: string, action: () => Promise<void>) => {
    if (operation.current) return;
    const owner = {};
    operation.current = owner;
    setBusy(name);
    setFailure(null);
    try {
      await action();
    } catch (e) {
      if (operation.current === owner) setFailure(errorText(e));
    } finally {
      if (operation.current === owner) {
        operation.current = null;
        setBusy(null);
      }
    }
  };
  const openConnectors = () =>
    run('connectors', async () => {
      await native.shell.openExternal(CLAUDE_CONNECTORS);
      if (operation.current) setExternal(true);
    });
  const signIn = (name: string) =>
    run(name, async () => {
      const options = await native.claude.mcpLoginCommand(bin, name, account, mode);
      if (operation.current) setLogin({ name, id: crypto.randomUUID(), options });
    });
  const finish = (code: number) => {
    setLogin(null);
    if (code !== 0) setFailure('Sign-in did not finish. Try again, or open Claude Code and use /mcp.');
    reload();
  };

  return (
    <Group
      title="MCP servers"
      desc="Connect tools to Claude Code. Sign in where required, then check the connection."
      action={
        <div className="settings-actions">
          <button className="btn-pill" onClick={reload}>
            Refresh status
          </button>
          {!adding && (
            <button className="btn-pill soft" onClick={() => setAdding(true)}>
              <Plus size={13} /> Add server
            </button>
          )}
        </div>
      }
    >
      {err && (
        <div className="settings-pad" role="alert">
          {err}
        </div>
      )}
      {failure && (
        <div className="settings-pad" role="alert">
          {failure}
        </div>
      )}
      {external && (
        <div className="settings-pad" role="status">
          Finish connecting in Claude with the same account used in MoPilot, then refresh status.
        </div>
      )}
      {servers.length === 0 && !adding && !err && <Row title={loaded ? 'None configured' : 'Loading…'} />}
      {servers.map((server) => {
        const cap = claudeMcpCapabilities(server);
        const status = mcpConnectionStatus(server.status);
        return (
          <Row key={server.name} title={server.name} desc={cap.description}>
            <span className={`hp-badge ${status.tone}`}>{status.label}</span>
            {cap.connector && (
              <button className="btn-pill soft" disabled={!!busy} onClick={openConnectors}>
                {server.status === 'needs-auth' ? 'Connect in Claude' : 'Manage in Claude'}
              </button>
            )}
            {cap.signIn && (
              <button className="btn-pill soft" disabled={!!busy || !!login} onClick={() => signIn(server.name)}>
                {busy === server.name ? 'Starting sign-in…' : 'Sign in'}
              </button>
            )}
            {cap.removeScope && (
              <button
                className="btn-pill"
                disabled={!!busy || !!login}
                onClick={() =>
                  run(server.name, async () => {
                    const argv = ['mcp', 'remove', '--scope', cap.removeScope!, server.name];
                    if (!confirm(`Run: ${shellLine([bin, ...argv])}`)) return;
                    await native.claude.mcp(bin, argv, account, cwd, mode);
                    if (operation.current) reload();
                  })
                }
              >
                Remove
              </button>
            )}
          </Row>
        );
      })}
      {login && (
        <div className="settings-pad">
          <p role="status">Sign in to {login.name} in your browser. If it does not open, follow the instructions below.</p>
          <div style={{ height: 220, position: 'relative' }}>
            <TermView
              key={login.id}
              tab={{
                id: login.id,
                title: 'MCP sign-in',
                cwd,
                command: login.options.command,
                windowsCommandLine: login.options.windowsCommandLine,
                env: login.options.env,
                signIn: true,
              }}
              visible
              onExit={finish}
              onError={(message) => {
                setLogin(null);
                setFailure(message);
              }}
            />
          </div>
          <button
            className="btn-pill"
            onClick={() => {
              setLogin(null);
              reload();
            }}
          >
            Cancel sign-in
          </button>
        </div>
      )}
      {adding && (
        <AddMcp
          bin={bin}
          account={account}
          mode={mode}
          onDone={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </Group>
  );
}
