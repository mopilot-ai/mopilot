// The Changes card's "Create pull request" form: title, description and base prefilled from the branch, created in the app, with every refusal shown and the input kept.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../store/core';
import type { PrDraft } from '../../lib/native/prMonitor';
import { errorText } from '../../lib/ignored';
import { busyField, imeComposing } from '../../lib/focus';
import type { PrMonitorApi } from '../thread/usePrMonitor';

type Draft = Extract<PrDraft, { status: 'draft' }>;

/**
 * Reads the draft once per mount (and again on Retry); the newest read wins and nothing lands after unmount. Submit is
 * the user's click: main pushes the branch, creates the pull request and binds it to this chat's monitor, whose change
 * then replaces this form with the PR's rows.
 */
export function PrCreateForm({
  chatId,
  api,
  unavailable = false,
  onClose,
}: {
  chatId: string;
  api: PrMonitorApi;
  unavailable?: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [error, setError] = useState('');
  // gh could not create it here and GitHub's form opened instead: why, kept on screen
  const [opened, setOpened] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const life = useRef({ live: false, read: 0, writing: false });
  const load = useCallback(async () => {
    const owner = life.current;
    const read = ++owner.read;
    setError('');
    try {
      const value = await api.createDraft(chatId);
      if (!owner.live || owner.read !== read) return;
      if (value.status === 'refused') return setError(value.text);
      setDraft(value);
      setTitle(value.title);
      setBody(value.body);
      setBase(value.base);
    } catch (e) {
      if (owner.live && owner.read === read) setError(errorText(e));
    }
  }, [api, chatId]);
  useEffect(() => {
    const owner = { live: true, read: 0, writing: false };
    life.current = owner;
    void load();
    return () => {
      owner.live = false;
    };
  }, [load]);
  // the title is what the user came to write
  useEffect(() => {
    if (draft) input.current?.focus();
  }, [draft]);
  const submit = async (from: Draft) => {
    const owner = life.current;
    if (owner.writing) return;
    owner.writing = true;
    setBusy(true);
    setError('');
    setOpened('');
    try {
      const result = await api.create(chatId, { title: title.trim(), body, base: base.trim(), branch: from.branch });
      if (result.status === 'refused') {
        if (owner.live) setError(result.text);
      } else if (result.status === 'web') {
        if (owner.live) setOpened(result.why);
      } else {
        const done = result.status === 'exists' ? 'Pull request already exists' : 'Pull request created';
        if (result.bound) toast(`${done}; attached to this chat`);
        // made for a chat that has since changed: say where it is instead of attaching it to another context
        else toast(`${done}: ${result.url}`);
        if (owner.live) onClose();
      }
    } catch (e) {
      if (owner.live) setError(errorText(e));
    } finally {
      owner.writing = false;
      if (owner.live) setBusy(false);
    }
  };
  return (
    <form
      className="summary-track"
      aria-label="Create pull request"
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        if (!unavailable && draft && title.trim()) void submit(draft);
      }}
      onKeyDown={(e) => {
        // the form's own Escape: it closes the form, not the turn or pane behind it
        if (e.key !== 'Escape' || imeComposing(e)) return;
        e.stopPropagation();
        onClose();
      }}
    >
      {draft ? (
        <>
          <input
            aria-label="Pull request title"
            placeholder="Title"
            value={title}
            {...busyField(busy)}
            ref={input}
            className="text-input"
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            aria-label="Pull request description"
            placeholder="Description"
            value={body}
            rows={5}
            {...busyField(busy)}
            className="text-input"
            onChange={(e) => setBody(e.target.value)}
          />
          <input
            aria-label="Base branch"
            placeholder="Base branch (the repository’s default when empty)"
            title={
              draft.stacked ? 'The branch of the pull request this chat’s work is stacked on' : `${draft.branch} merges into this branch`
            }
            value={base}
            {...busyField(busy)}
            className="text-input"
            onChange={(e) => setBase(e.target.value)}
          />
        </>
      ) : (
        !error && (
          <p className="summary-hint" role="status">
            Reading the branch…
          </p>
        )
      )}
      {opened && (
        <p className="summary-hint" role="status">
          GitHub CLI could not create it here, so GitHub’s form opened in your browser: {opened}
        </p>
      )}
      {error && (
        <p className="summary-track-error" role="alert">
          {error}
        </p>
      )}
      {unavailable && (
        <p className="summary-hint" role="status">
          Refresh to verify this branch before creating the pull request.
        </p>
      )}
      <div className="summary-track-actions">
        <button type="button" className="link-btn" onClick={onClose}>
          Cancel
        </button>
        {draft ? (
          <button type="submit" className="btn-pill" disabled={unavailable || busy || !title.trim()}>
            {busy ? 'Creating…' : 'Create pull request'}
          </button>
        ) : (
          error && (
            <button type="button" className="btn-pill" disabled={unavailable} onClick={() => void load()}>
              Retry
            </button>
          )
        )}
      </div>
    </form>
  );
}
