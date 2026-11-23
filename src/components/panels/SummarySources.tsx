// The summary's shared links and URL form: add a complete link to this chat's next message, keeping its draft.
import { useId, useMemo, useRef, useState } from 'react';
import { giveBackToComposer } from '../../store/send';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/core';
import type { TurnState } from '../../store/types';
import { stripInjectedContext } from '../../lib/format';
import { memoByObject } from '../../lib/memoByObject';
import { proseLinks, trimLink } from '../../../shared/proseLinks.mjs';
import { openLink } from '../../session/open';
import { cancelOnEscape, imeComposing } from '../../lib/focus';
import { ChevronDown, Plus } from '../ui/icons';

/** The links a turn mentions, in order, as [href, host]: computed once per turn. */
const turnSources = memoByObject((t: TurnState) => {
  const out = new Map<string, string>();
  const add = (u: string) => {
    const text = trimLink(u);
    if (!URL.canParse(text)) return;
    const url = new URL(text);
    if (!out.has(url.href)) out.set(url.href, url.host);
  };
  for (const it of t.items) {
    if (it.type === 'webSearch') {
      const action = it.action as { url?: string | null } | null;
      if (action?.url) add(action.url);
      for (const r of (it.results ?? []) as ({ url?: string | null } | null)[]) if (r?.url) add(r.url);
    } else if (it.type === 'userMessage') {
      for (const c of it.content ?? []) if (c.type === 'text') proseLinks(stripInjectedContext(c.text)).forEach(add);
    } else if (it.type === 'agentMessage') {
      proseLinks(it.text ?? '').forEach(add);
    } else if (it.type === 'commandExecution') {
      proseLinks(it.command ?? '').forEach(add);
    }
  }
  return [...out.entries()];
});

/** A host's first letter or digit, past a leading "www.", for its tile. */
export const monogram = (host: string) => (host.replace(/^www\./, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();

/** Chat changes retire the form and expanded list together. */
export function SummarySources({ threadId }: { threadId: string }) {
  return <SourcesFor key={threadId} threadId={threadId} />;
}

function SourcesFor({ threadId }: { threadId: string }) {
  // [href, host] pairs flattened to strings, so a streamed frame that adds no link compares equal
  const flat = useStore(
    useShallow((s) => {
      const out = new Map<string, string>();
      for (const t of s.runtime[threadId]?.turns ?? []) for (const [href, host] of turnSources(t)) if (!out.has(href)) out.set(href, host);
      return [...out.entries()].flat();
    }),
  );
  const [all, setAll] = useState(false);
  const [entering, setEntering] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const fieldId = useId();
  const urls = useMemo(() => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]] as [string, string]), [flat]);
  const hosts = [...new Map(urls.map(([href, host]) => [host, href])).entries()];
  const shown = all ? urls.map(([href, host]) => [host, href] as [string, string]) : hosts.slice(0, 3);
  const cancel = () => {
    setEntering(false);
    setValue('');
    setError('');
    addButton.current!.focus();
  };
  const add = () => {
    const text = value.trim();
    // A bare host:port is an address; an actual scheme is left to the URL parser, even with missing slashes.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/?#:@]+:\d+(?:[/?#]|$)/.test(text);
    const url = URL.parse(hasScheme ? text : `https://${text}`);
    if (/\s/.test(text) || !url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      setError('Enter a valid http:// or https:// link.');
      return;
    }
    try {
      giveBackToComposer(threadId, url.href);
      setEntering(false);
      setValue('');
      setError('');
    } catch {
      setError('Could not add the link. Try again.');
    }
  };
  return (
    <section className="summary-group summary-section">
      <div className="summary-section-head">
        <span>
          Sources
          {urls.length > 0 && <span className="summary-count">{urls.length}</span>}
        </span>
        <button ref={addButton} className="icon-btn xs" title="Add source" aria-expanded={entering} onClick={() => setEntering(true)}>
          <Plus size={16} />
        </button>
      </div>
      {entering && (
        <form
          className="summary-track"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          onKeyDown={(e) => {
            if (cancelOnEscape(e, cancel)) e.stopPropagation();
            if (e.key === 'Enter' && imeComposing(e)) e.preventDefault();
          }}
        >
          <input
            autoFocus
            aria-label="Source URL"
            aria-describedby={`${fieldId}-hint`}
            aria-invalid={!!error}
            aria-errormessage={error ? `${fieldId}-error` : undefined}
            inputMode="url"
            placeholder="https://example.com"
            className="text-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError('');
            }}
          />
          <p className="summary-context-detail" id={`${fieldId}-hint`}>
            Add a link to your next message.
          </p>
          <div className="summary-track-actions">
            <button type="button" className="link-btn" onClick={cancel}>
              Cancel
            </button>
            <button type="submit" className="btn-pill" disabled={!value.trim()}>
              Add to message
            </button>
          </div>
          {error && (
            <p className="summary-track-error" id={`${fieldId}-error`} role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      {shown.map(([host, href]) => (
        <button key={href} className="summary-row" onClick={() => openLink(href)} title={href}>
          <span className="summary-monogram" aria-hidden="true">
            {monogram(host)}
          </span>
          <span className="summary-label">{all ? href.replace(/^https?:\/\//, '') : host}</span>
        </button>
      ))}
      {urls.length > 0 && (
        <button className="summary-row muted" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          <span className="summary-monogram-gap" aria-hidden="true" />
          <span className="summary-label">
            {all ? 'Show less' : urls.length === 1 ? 'Show full link' : `Show all ${urls.length} links`}
          </span>
          <ChevronDown size={12} strokeWidth={2.2} className={all ? 'flipped' : undefined} />
        </button>
      )}
    </section>
  );
}
