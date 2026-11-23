// Explicit ACP registry browsing and installation, with reads retired on replacement/unmount and installs owned by main.
// @plain-copy: directory controls use agent names and actions rather than protocol or package terminology.
import { useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { detectBasicHarnesses } from '../../session/harness/acp';
import { Group } from '../pages/settings/Controls';
import { RegistryInstallOutput } from './RegistryInstallOutput';
import { DIRECTORY_LABEL } from '../../lib/registryCopy';

type Catalog = Awaited<ReturnType<typeof native.acp.registryList>>;

export function RegistryAgents() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingInstall = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  async function load(force = false) {
    const owner = ++generation.current;
    setLoading(true);
    try {
      const snapshot = await native.acp.registryList(force);
      if (owner !== generation.current) return;
      setCatalog(snapshot);
      setError(snapshot.error);
    } catch (failure) {
      if (owner === generation.current) setError(errorText(failure));
    } finally {
      if (owner === generation.current) setLoading(false);
    }
  }

  async function install(id: string, repair = false) {
    if (pendingInstall.current) return;
    pendingInstall.current = true;
    const owner = ++generation.current;
    setInstalling(id);
    setLoading(false);
    setError(null);
    try {
      if (repair) await native.acp.registryRepair(id);
      else await native.acp.registryInstall(id);
      await detectBasicHarnesses();
      if (owner === generation.current) await load();
    } catch (failure) {
      if (owner === generation.current) setError(errorText(failure));
    } finally {
      pendingInstall.current = false;
      if (mounted.current) setInstalling(null);
    }
  }

  const shown =
    catalog?.agents.filter((agent) => `${agent.name} ${agent.vendor} ${agent.description}`.toLowerCase().includes(query.toLowerCase())) ??
    [];
  return (
    <Group
      title={DIRECTORY_LABEL}
      desc="Add another agent from its publisher. It must pass MoPilot’s compatibility and tool checks before you can start a chat."
    >
      <div className="basic-row-foot">
        <button
          className="btn-pill"
          disabled={loading || !!installing}
          onClick={() => {
            setOpen(true);
            void load(!!catalog);
          }}
        >
          {loading ? 'Loading directory…' : catalog ? 'Refresh directory' : 'Browse agent directory'}
        </button>
      </div>
      {error && (
        <p className="settings-lead" role="alert">
          {error}
        </p>
      )}
      {open && catalog && (
        <>
          <div className="basic-row-foot">
            <input
              type="search"
              aria-label="Find an agent"
              placeholder="Find an agent…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {shown.map((agent) => (
            <div className="basic-row" key={agent.id} data-registry-agent={agent.id}>
              <div className="basic-row-main">
                <div className="basic-row-text">
                  <div className="basic-row-name">
                    {agent.name}
                    <span className="basic-row-state">{agent.version}</span>
                  </div>
                  <div className="basic-row-desc">{agent.description || agent.vendor}</div>
                </div>
                <button
                  className="btn-pill"
                  disabled={
                    !!installing || (agent.installedVersion !== null && !agent.needsUpdate ? !agent.repairAvailable : !agent.available)
                  }
                  onClick={() => void install(agent.id, agent.installedVersion !== null && !agent.needsUpdate)}
                >
                  {installing === agent.id
                    ? 'Installing…'
                    : agent.installedVersion !== null && !agent.needsUpdate
                      ? 'Repair'
                      : !agent.available
                        ? 'Unavailable here'
                        : agent.installedVersion !== null
                          ? 'Update'
                          : 'Install'}
                </button>
                {agent.needsUpdate && agent.repairAvailable && (
                  <button className="text-link" disabled={!!installing} onClick={() => void install(agent.id, true)}>
                    Repair installed version
                  </button>
                )}
              </div>
              <RegistryInstallOutput id={agent.id} />
            </div>
          ))}
          {shown.length === 0 && <p className="settings-lead">No agents match this search.</p>}
        </>
      )}
    </Group>
  );
}
