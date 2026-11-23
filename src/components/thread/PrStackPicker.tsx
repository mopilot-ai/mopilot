// Parent PR selection with retiring reads, retained search and retryable GitHub base changes.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrStackCandidate } from '../../lib/native/prMonitor';
import { errorText } from '../../lib/ignored';
import { focusAfterPlacement } from '../../lib/placedFocus';
import type { PrMonitorApi } from './usePrMonitor';
import { Popover } from '../ui/Popover';
import { GitPullRequest, Search, Spinner } from '../ui/icons';
import styles from './prMonitor.module.css';

export function PrStackPicker({
  chatId,
  url,
  api,
  anchor,
  onClose,
}: {
  chatId: string;
  url: string;
  api: PrMonitorApi;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const [parents, setParents] = useState<PrStackCandidate[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const life = useRef({ live: false, read: 0, writing: false });
  const load = useCallback(async () => {
    const owner = life.current;
    const read = ++owner.read;
    setParents(null);
    setError('');
    try {
      const value = await api.stackCandidates(chatId, url);
      if (owner.live && owner.read === read) setParents(value);
    } catch (e) {
      if (owner.live && owner.read === read) setError(errorText(e));
    }
  }, [api, chatId, url]);
  useEffect(() => {
    const owner = { live: true, read: 0, writing: false };
    life.current = owner;
    const cancelFocus = focusAfterPlacement(input.current!);
    void load();
    return () => {
      cancelFocus();
      owner.live = false;
    };
  }, [load]);
  const pick = async (parent: PrStackCandidate) => {
    const owner = life.current;
    if (owner.writing) return;
    owner.writing = true;
    setBusy(true);
    setError('');
    try {
      await api.stack(chatId, url, parent.url);
      if (owner.live) onClose();
    } catch (e) {
      if (owner.live) setError(errorText(e));
    } finally {
      owner.writing = false;
      if (owner.live) setBusy(false);
    }
  };
  const needle = query.trim().toLowerCase();
  const matches = parents?.filter((p) => `${p.title} ${p.headRefName} ${p.url}`.toLowerCase().includes(needle));
  return (
    <Popover anchor={anchor} open onClose={onClose} placement="top-end" className={styles.prStackPicker}>
      <div role="dialog" aria-label="Stack on another pull request" aria-busy={busy}>
        <div className={styles.prStackHeading}>Stack on another PR</div>
        <p className={styles.prStackHelp}>
          Choose the PR this change builds on. Its branch becomes the base; your commits stay on your branch.
        </p>
        <label className={styles.prStackSearch}>
          <Search size={14} />
          <input
            ref={input}
            type="search"
            aria-label="Find a parent pull request"
            placeholder="Search pull requests…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className={styles.prStackOptions} aria-label="Parent pull requests">
          {matches?.map((parent) => (
            <button key={parent.url} className={styles.prStackOption} disabled={busy} onClick={() => void pick(parent)}>
              <GitPullRequest size={15} />
              <span>
                <span className={styles.prStackTitle}>{parent.title}</span>
                <span className={styles.prStackBranch}>
                  #{parent.url.split('/').at(-1)} · {parent.headRefName}
                </span>
              </span>
            </button>
          ))}
          {matches?.length === 0 && (
            <p className={styles.prStackEmpty}>{parents?.length ? 'No matching pull requests.' : 'No eligible parent PRs.'}</p>
          )}
          {!parents && !error && (
            <div className={styles.prStackEmpty} role="status">
              <Spinner size={14} /> Loading pull requests…
            </div>
          )}
        </div>
        {error && (
          <div className={styles.prStackError} role="alert">
            {error}
            {!parents && (
              <button className="link-btn" onClick={() => void load()}>
                Retry
              </button>
            )}
          </div>
        )}
        {busy && (
          <div className={styles.prStackEmpty} role="status">
            Updating PR base…
          </div>
        )}
        <button className={`${styles.prStackCancel} link-btn`} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Popover>
  );
}
