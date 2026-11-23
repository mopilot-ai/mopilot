// Codex hook groups and plugin logos.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { currentCwdForNewChat } from '../../../store/projects';
import { codexRequest } from '../../../harness/adapters/codex';
import { errorText } from '../../../lib/ignored';
import { usePlugins, ensurePlugins, PluginLogo } from './Plugins';
import { WebLink } from '../../ui/WebLink';
import { ChevronDown, ChevronRight, Spinner, RefreshCw } from '../../ui/icons';
import { Group, Row, groupBy } from '../../pages/Settings';
import type { HookMetadata } from '../../../protocol/v2/HookMetadata';
import type { HooksListResponse } from '../../../protocol/v2/HooksListResponse';

import { LoadFailed } from './settingsShared';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A hook as its row reads it: the handler fields of every handler type, absent on the others. */
type HookRow = HookMetadata & { command?: string; server?: string; tool?: string };

export function Hooks() {
  const [hooks, setHooks] = useState<HookRow[] | null>(null);
  // a list that couldn't be read: said with Retry, not shown as no hooks
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const cwd = currentCwdForNewChat();
  // another folder shows none of the last one's hooks: reset while rendering, so no frame does
  const [listedFor, setListedFor] = useState(cwd);
  if (listedFor !== cwd) {
    setListedFor(cwd);
    setHooks(null);
    setError(null);
  }
  // overlapping reads (another folder, Retry): only the newest lands
  const reads = useRef(0);
  const load = () => {
    const read = ++reads.current;
    codexRequest<HooksListResponse>('hooks/list', { cwds: [cwd] }).then(
      (r) => {
        if (read !== reads.current) return;
        setHooks(r.data.flatMap((d) => d.hooks));
        setError(null);
      },
      (e: unknown) => {
        if (read !== reads.current) return;
        setHooks([]);
        setError(errorText(e));
      },
    );
  };
  // the new-chat folder's hooks, listed again for another folder
  useEffectOn([cwd], () => {
    load();
  });
  const groups = useMemo(() => groupBy(hooks ?? [], (h) => h.pluginId ?? 'config.toml'), [hooks]);
  return (
    <>
      <div className="settings-subrow">
        <p className="settings-sub">
          Hooks from config and plugins. <WebLink href="https://developers.openai.com/codex/hooks">Learn more</WebLink>
        </p>
        <button className="icon-btn" onClick={load} title="Refresh">
          <RefreshCw size={15} />
        </button>
      </div>
      {!hooks && <Spinner size={16} />}
      {error && <LoadFailed what="list the hooks" error={error} retry={load} />}
      {hooks && hooks.length === 0 && !error && <div className="empty-state">No hooks configured</div>}
      {hooks && hooks.length > 0 && (
        <Group title={Object.keys(groups).every((k) => k !== 'config.toml') ? 'From Plugins' : 'From plugins and config'}>
          {Object.entries(groups).map(([k, list]) => (
            <div key={k}>
              <Row
                title={
                  <span className="import-src">
                    <HookPluginLogo id={k} />
                    {cap(k.replace(/@.*/, ''))}
                  </span>
                }
                desc={`${list.length} ${list.length === 1 ? 'hook' : 'hooks'}`}
                onClick={() => setOpen(open === k ? null : k)}
              >
                {open === k ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </Row>
              {open === k &&
                list.map((h) => (
                  <Row
                    key={h.key}
                    title={h.eventName}
                    desc={`${h.handlerType === 'mcpTool' ? `${h.server}.${h.tool}` : (h.command ?? h.handlerType)}${h.matcher ? ` · matcher ${h.matcher}` : ''}`}
                  >
                    <span className={`status-pill ${h.trustStatus === 'trusted' ? 'ok' : ''}`}>
                      {h.enabled ? h.trustStatus : 'disabled'}
                    </span>
                  </Row>
                ))}
            </div>
          ))}
        </Group>
      )}
    </>
  );
}

function HookPluginLogo({ id }: { id: string }) {
  const plugins = usePlugins((s) => s.plugins);
  useEffect(ensurePlugins, []);
  const name = id.replace(/@.*/, '');
  const p = plugins?.find((x) => x.name === name || x.id === id);
  return p ? <PluginLogo p={p} size={20} /> : null;
}
