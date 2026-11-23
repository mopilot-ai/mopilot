// The folder picker for a remote machine (package 2.7): browse what the machine shares, clone a repository there with its progress, or make a worktree of a repository; "Use this folder" hands the machine's path back.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { HostUpdateAction } from '../host/HostUpdateAction';
import { ArrowUp, Folder, GitBranch } from '../ui/icons';
import { native } from '../../lib/native';
import { busyField } from '../../lib/focus';
import type { HostListing } from '../../lib/native/host';
import { RemoteGitSignin } from './RemoteGitSignin';
import { GIT_HOST } from '../../../shared/host/gitLogin.mjs';
import { identityKey } from '../../../shared/identityKey.mjs';
import {
  attemptKey,
  cloneNeedsSignIn,
  folderNotice,
  httpsHostOf,
  hostFolders,
  joinRemote,
  parentRemote,
  repoFolderName,
} from '../../lib/hostFolders';

type Form = null | { kind: 'clone'; url: string; name: string } | { kind: 'worktree'; repo: string; branch: string };

export function HostFolderPicker({
  hostId,
  name,
  onPick,
  onClose,
}: {
  hostId: string;
  name: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<HostListing | null>(null);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<Form>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  // a clone that failed on sign-in: this Mac's may be offered for that one address
  const [offer, setOffer] = useState<{ url: string; dest: string; failedKey: string } | null>(null);
  // the newest request owns the list; one that settles late (or after the picker closed) is dropped
  const latest = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const open = useCallback(
    async (path?: string) => {
      const mine = ++latest.current;
      setNotice('');
      try {
        const next = await hostFolders.list(hostId, { path });
        if (alive.current && mine === latest.current) setListing(next);
      } catch (e) {
        if (alive.current && mine === latest.current) setNotice(folderNotice(e));
      }
    },
    [hostId],
  );
  useEffect(() => void open(), [open]);

  /** A clone or a worktree: the machine's answer is the folder to use. The form and its input stay when it fails. */
  const run = async (key: string, work: () => Promise<{ path: string }>, signInFor: { url: string; dest: string } | null = null) => {
    setBusy(true);
    setNotice('');
    setOffer(null);
    setProgress('');
    const off = native.host.onCloneProgress((p) => p.hostId === hostId && p.key === key && setProgress(`${p.phase} ${p.percent}%`));
    try {
      const made = await work();
      if (alive.current) onPick(made.path);
    } catch (e) {
      if (alive.current) {
        setProgress('');
        setNotice(folderNotice(e));
        if (signInFor && cloneNeedsSignIn(e) && httpsHostOf(signInFor.url)) setOffer({ ...signInFor, failedKey: key });
      }
    } finally {
      off();
      if (alive.current) setBusy(false);
    }
  };
  const submit = (formNow: Form, listingNow: HostListing | null) => {
    // the buttons that call this exist only with a form open over a loaded listing
    const form = formNow as NonNullable<Form>;
    const listing = listingNow as HostListing;
    const key = attemptKey();
    if (form.kind === 'clone') {
      const dest = joinRemote(listing.path, form.name.trim());
      void run(key, () => hostFolders.clone(hostId, { key, url: form.url.trim(), dest }), { url: form.url.trim(), dest });
    } else void run(key, () => hostFolders.worktree(hostId, { key, repo: form.repo, branch: form.branch.trim() }));
  };
  /** The click is the consent: this Mac's sign-in for the address's host is lent to one new attempt. */
  const cloneWithMacSignIn = (o: { url: string; dest: string }) => {
    const key = attemptKey();
    void run(key, () => hostFolders.clone(hostId, { key, ...o, useMacSignIn: true }));
  };
  const up = listing && !listing.roots.includes(listing.path) ? parentRemote(listing.path) : null;

  return (
    <Modal title={`Folder on ${name}`} onClose={onClose}>
      <div className="host-picker">
        <div className="host-picker-path" title={listing?.path}>
          <button className="icon-btn xs" disabled={!up || busy} onClick={() => up && void open(up)} aria-label="Up one folder">
            <ArrowUp size={14} />
          </button>
          <span>{listing?.path ?? 'Loading…'}</span>
        </div>
        {notice && (
          <div className="host-picker-notice" role="alert">
            {notice}
            <HostUpdateAction hostId={hostId} text={notice} />
          </div>
        )}
        {offer && (
          <>
            {httpsHostOf(offer.url) === GIT_HOST && (
              <RemoteGitSignin
                key={identityKey(hostId, offer.failedKey)}
                machine={{ id: hostId, name, away: false }}
                host={GIT_HOST}
                recoveryKey={identityKey(hostId, offer.failedKey)}
              />
            )}
            <div className="host-picker-signin">
              <button className="btn sm" disabled={busy} onClick={() => cloneWithMacSignIn(offer)}>
                Use this Mac’s sign-in
              </button>
              <span>Used once, not saved on the machine.</span>
            </div>
          </>
        )}
        <div className="host-picker-list" role="list" aria-label="Folders">
          {listing?.entries.map((e) => (
            <div className="host-picker-row" role="listitem" key={e.path}>
              <button className="host-picker-open" disabled={busy} onClick={() => void open(e.path)}>
                <Folder size={15} strokeWidth={1.7} />
                <span>{e.name}</span>
              </button>
              {e.git && (
                <button className="btn sm" disabled={busy} onClick={() => setForm({ kind: 'worktree', repo: e.path, branch: '' })}>
                  <GitBranch size={13} /> Worktree…
                </button>
              )}
            </div>
          ))}
          {listing?.entries.length === 0 && <div className="host-picker-empty">No folders</div>}
        </div>
        {form?.kind === 'clone' && (
          <div className="host-picker-form">
            <input
              className="text-input"
              aria-label="Repository address"
              placeholder="https://… or git@host:org/repo.git"
              value={form.url}
              {...busyField(busy)}
              onChange={(e) => {
                setOffer(null);
                setForm({ ...form, url: e.target.value, name: repoFolderName(e.target.value) });
              }}
            />
            <input
              className="text-input"
              aria-label="Folder name"
              value={form.name}
              {...busyField(busy)}
              onChange={(e) => {
                setOffer(null);
                setForm({ ...form, name: e.target.value });
              }}
            />
          </div>
        )}
        {form?.kind === 'worktree' && (
          <div className="host-picker-form">
            <input
              className="text-input"
              aria-label="Branch"
              placeholder={`Branch for ${form.repo.split('/').pop()}`}
              value={form.branch}
              {...busyField(busy)}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
            />
          </div>
        )}
        {progress && (
          <div className="host-picker-progress" aria-live="polite">
            {progress}
          </div>
        )}
        <div className="acct-dialog-actions">
          {form ? (
            <>
              <button className="btn sm" disabled={busy} onClick={() => setForm(null)}>
                Cancel
              </button>
              <span style={{ flex: 1 }} />
              <button
                className="btn primary sm"
                disabled={busy || !(form.kind === 'clone' ? form.url.trim() && form.name.trim() : form.branch.trim())}
                onClick={() => submit(form, listing)}
              >
                {form.kind === 'clone' ? 'Clone' : 'Create worktree'}
              </button>
            </>
          ) : (
            <>
              <button className="btn sm" disabled={!listing || busy} onClick={() => setForm({ kind: 'clone', url: '', name: '' })}>
                Clone repository…
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn primary sm" disabled={!listing || busy} onClick={() => listing && onPick(listing.path)}>
                Use this folder
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
