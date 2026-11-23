// Settings → Claude Code → Extensions. MCP servers are added with `claude mcp add --scope user` after
// the command is shown; plugins and hooks are read from the CLI's own files and managed with the CLI.
import { useEffect, useState } from 'react';
import { useEffectOn, useWindowListener } from '../../../lib/effects';
import { useClaudeKey, refreshClaudeKey } from '../../../session/harness/billing';
import { currentCwdForNewChat } from '../../../store/projects';
import { navigate, openPaneTab } from '../../../store/panes';
import { useStore } from '../../../store/core';
import { openFile } from '../../../session/open';
import { native, type ClaudeCatalog, type ClaudeSlashCommand } from '../../../lib/native';
import { shellLine } from '../../../lib/mcpConfig';
import { ClaudeMcp } from './ClaudeMcp';
import type { ClaudeMcpServer } from '../../../harness/mcpConnection';
import { parseClaudeHooks, type ClaudeHook } from '../../../lib/claudeHooks';
import { withKeys } from '../../../lib/listKeys';
import { Group, Row } from '../../pages/Settings';
import { errorText } from '../../../lib/ignored';

/** Plugins are managed by `claude plugin`; Settings lists them and opens the CLI for installing. */
/** A read that failed: what it said, and how to try it again. */
export interface LoadError {
  message: string;
  retry: () => void;
}

/** The installed plugins; `error`: why they couldn't be read, shown with Retry instead of "No plugins installed". */
export function ClaudePlugins({ bin, plugins, error }: { bin: string; plugins: ClaudeCatalog['plugins'] | null; error: LoadError | null }) {
  const home = useStore((s) => s.home);
  const install = () => {
    openPaneTab('terminal', { title: 'claude plugin', cwd: home ?? undefined, input: `${shellLine([bin])} plugin install ` });
    // the terminal lives beside the chat, not on this page
    navigate({ name: 'home' });
  };
  return (
    <Group title="Plugins" desc="Manage with the claude plugin command.">
      {(error || !plugins?.length) && (
        <Row title={error ? "Couldn't read the plugins" : plugins ? 'No plugins installed' : 'Loading…'} desc={error?.message}>
          {error && (
            <button className="btn-pill soft" onClick={error.retry}>
              Retry
            </button>
          )}
        </Row>
      )}
      {plugins?.map((p) => (
        <Row key={p.name} title={p.name} desc={p.path ?? undefined} />
      ))}
      <Row title="Install a plugin" desc="Add the plugin name in Terminal.">
        <button className="btn-pill soft" onClick={install}>
          Install with claude plugin…
        </button>
      </Row>
    </Group>
  );
}

/** Hooks in the user's settings.json, read-only. */
function Hooks() {
  const [state, setState] = useState<{ path: string; hooks: ClaudeHook[] | null } | null>(null);
  // settings.json couldn't be found or read: said, instead of loading forever
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    native.fs
      .configRoots()
      .then(async (r) => {
        const path = `${r.claudeRoot}/settings.json`;
        const hooks = parseClaudeHooks(await native.fs.readText(path));
        if (alive) setState({ path, hooks });
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Group title="Hooks" desc="Edit hooks in settings.json.">
      {!state?.hooks?.length && (
        <Row
          title={
            error
              ? `Couldn't read settings.json: ${error}`
              : !state
                ? 'Loading…'
                : state.hooks
                  ? 'No hooks configured'
                  : "settings.json isn't valid JSON"
          }
        />
      )}
      {withKeys(state?.hooks ?? [], (h) => JSON.stringify(h)).map(({ key, item: h }) => (
        <Row key={key} title={h.event} desc={`${h.run || h.type}${h.matcher ? ` · matcher ${h.matcher}` : ''}`} />
      ))}
      <Row title="settings.json" desc={state?.path.replace(/^\/Users\/[^/]+/, '~')}>
        <button className="btn-pill" disabled={!state} onClick={() => openFile(state!.path)}>
          Open settings.json
        </button>
      </Row>
    </Group>
  );
}

export function ClaudeExtensions({ bin }: { bin: string }) {
  const cwd = currentCwdForNewChat();
  const account = useStore((s) => s.claudeAccounts.active);
  const mode = useClaudeKey()?.mode ?? 'subscription';
  useWindowListener('focus', () => {
    void refreshClaudeKey();
  });
  const [x, setX] = useState<{ commands: ClaudeSlashCommand[]; mcp: ClaudeMcpServer[]; mcpError?: string } | null>(null);
  const [plugins, setPlugins] = useState<ClaudeCatalog['plugins'] | null>(null);
  const [pluginsErr, setPluginsErr] = useState<LoadError | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // another binary or folder shows none of the last one's commands, servers or plugins: reset while rendering, so no
  // frame does (a Reload keeps what is shown until its read lands)
  const [readFor, setReadFor] = useState({ bin, cwd, account, mode });
  if (readFor.bin !== bin || readFor.cwd !== cwd || readFor.account !== account || readFor.mode !== mode) {
    setReadFor({ bin, cwd, account, mode });
    setX(null);
    setPlugins(null);
    setErr(null);
    setPluginsErr(null);
  }
  // read again for another binary or folder, and on Reload or Retry (a new tick)
  useEffectOn([bin, cwd, account, mode, tick], () => {
    let alive = true;
    // a reload starts clean: an earlier failure must not hide what this read finds
    setErr(null);
    setPluginsErr(null);
    native.claude
      .extras(bin, cwd, account)
      .then((r) => alive && setX(r))
      .catch((e) => alive && setErr(errorText(e)));
    native.claude
      .catalog(bin, cwd, account)
      .then((c) => alive && setPlugins(c.plugins))
      .catch((e) => alive && setPluginsErr({ message: errorText(e), retry: () => setTick((t) => t + 1) }));
    return () => {
      alive = false;
    };
  });
  return (
    <>
      <ClaudeMcp
        key={JSON.stringify([bin, cwd, account, mode])}
        mode={mode}
        cwd={cwd}
        account={account}
        bin={bin}
        servers={x?.mcp ?? []}
        err={(err ?? x?.mcpError) ? `Couldn't read them: ${err ?? x?.mcpError}` : null}
        loaded={!!x}
        reload={() => setTick((t) => t + 1)}
      />
      <ClaudePlugins bin={bin} plugins={plugins} error={pluginsErr} />
      <Group title="Skills and commands" desc="From ~/.claude and this project.">
        <Row
          title="Available"
          desc={
            x
              ? x.commands.length
                ? x.commands
                    .map((c) => `/${c.name}`)
                    .slice(0, 24)
                    .join('  ') + (x.commands.length > 24 ? `  … ${x.commands.length - 24} more` : '')
                : 'None'
              : 'Loading…'
          }
        />
      </Group>
      <Hooks />
    </>
  );
}
