// A new chat's Run on chip in the context bar: the one place it picks where it runs (this Mac, one of the user's machines through HostChip's menu, or a Codex Cloud environment when its agent has them); picking one drops the other. useCloudEnvs reads Codex Cloud's environments for it and for the plain Work in menu shown without Host.
import { useEffect, useState } from 'react';
import { Check, Cloud, ExternalLink } from '../ui/icons';
import { MenuRow } from '../ui/MenuList';
import { set as setState, useStore } from '../../store/core';
import { newChatHostPick, pickNewChatHost, setNewChatHostFolder } from '../../store/projects';
import { type CloudEnv, native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { openLink } from '../../session/open';
import { HostChip, type HostMachine } from './HostChip';

export const MANAGE_ENVIRONMENTS = 'https://chatgpt.com/codex/settings/environments';

/** Codex Cloud's environments, read once `open` first turns true; `envs` is null until they arrive, `error` why the list is empty. */
export function useCloudEnvs(open: boolean): { envs: CloudEnv[] | null; error: string | null } {
  const [envs, setEnvs] = useState<CloudEnv[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || envs) return;
    native.cloud.envs().then(
      (r) => {
        setEnvs(r.envs ?? []);
        setError(r.error ?? null);
      },
      // the menu says why it is empty, as for an error main answers
      (e) => {
        setEnvs([]);
        setError(errorText(e));
      },
    );
  }, [open, envs]);
  return { envs, error };
}

/** @param cloudCap the new chat's agent can run in Codex Cloud: its environments are one more group in the menu */
export function RunOnChip({ cloudCap }: { cloudCap: boolean }) {
  const cloudEnv = useStore((s) => (cloudCap ? s.newChatCloudEnv : null));
  const picked = useStore((s) => newChatHostPick(s)?.id ?? 'local');
  // read when the menu first shows the group, then kept while the bar stays, as the plain Work in menu does
  const [shown, setShown] = useState(false);
  const cloud = useCloudEnvs(cloudCap && shown);
  // a machine (this Mac included) picked while a cloud environment was: the chat runs on the machine
  const onPick = (m: HostMachine) => {
    if (cloudEnv) setState({ newChatCloudEnv: null });
    return pickNewChatHost(m);
  };
  return (
    <HostChip
      look="ctx"
      ownerId={picked}
      onPick={onPick}
      onFolder={setNewChatHostFolder}
      elsewhere={cloudEnv ? { label: cloudEnv.label, icon: <Cloud size={15} strokeWidth={1.7} aria-hidden="true" /> } : null}
      extra={
        cloudCap
          ? (close) => <CloudRows {...cloud} current={cloudEnv?.id ?? null} close={close} onShown={() => setShown(true)} />
          : undefined
      }
    />
  );
}

/** The Codex Cloud group: its environments as rows (null while they load), a cloud one picked drops any machine pick. */
function CloudRows({
  envs,
  error,
  current,
  close,
  onShown,
}: {
  envs: CloudEnv[] | null;
  error: string | null;
  current: string | null;
  close: () => void;
  onShown: () => void;
}) {
  // telling it twice is harmless: the flag only turns on
  useEffect(() => onShown(), [onShown]);
  const pick = (e: CloudEnv) => {
    close();
    pickNewChatHost({ id: 'local', name: 'This Mac' });
    setState({ newChatCloudEnv: { id: e.id, label: e.label } });
  };
  const note = (text: string) => (
    <MenuRow className="perm-item" disabled>
      <span className="menu-icon" />
      <span className="menu-label">
        <span className="menu-title">{text}</span>
      </span>
    </MenuRow>
  );
  return (
    <>
      <div className="menu-section-label" role="presentation">
        Codex Cloud
      </div>
      {!envs && note('Loading environments…')}
      {envs?.map((e) => (
        <MenuRow key={e.id} className="perm-item" role="menuitemradio" aria-checked={current === e.id} onClick={() => pick(e)}>
          <span className="menu-icon">
            <Cloud size={16} strokeWidth={1.7} aria-hidden="true" />
          </span>
          <span className="menu-label">
            <span className="menu-title">{e.label}</span>
          </span>
          <span className="menu-check">{current === e.id ? <Check size={16} strokeWidth={2} /> : null}</span>
        </MenuRow>
      ))}
      {envs && envs.length === 0 && note(error ?? 'No cloud environments')}
      <MenuRow
        className="perm-item"
        onClick={() => {
          close();
          openLink(MANAGE_ENVIRONMENTS);
        }}
      >
        <span className="menu-icon">
          <ExternalLink size={14} aria-hidden="true" />
        </span>
        <span className="menu-label">
          <span className="menu-title">Manage environments</span>
        </span>
      </MenuRow>
    </>
  );
}
