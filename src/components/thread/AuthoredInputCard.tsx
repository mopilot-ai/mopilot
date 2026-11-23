// Main-authored inputs replace user bubbles: app events use compact status disclosures; MoMo's content keeps its author card. Only the saved presentation is shown, never model instructions.
import { useState } from 'react';
import type { AuthoredInput } from '../../lib/authoredInput';
import { AUTHOR_LABEL } from '../../lib/authoredInput';
import { ChevronDown } from '../ui/icons';

export function AuthoredInputCard({ input }: { input: AuthoredInput }) {
  const [open, setOpen] = useState(false);
  if (input.by === 'mopilot')
    return (
      <div className={`step-group${open ? ' open' : ''}`} data-kind="authored" data-author={input.by}>
        {input.body ? (
          <button type="button" className="step-row summary status-note" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="step-text">{input.title}</span>
            <ChevronDown size={14} className="step-chevron" />
          </button>
        ) : (
          <div className="step-row status-note">
            <span className="step-text">{input.title}</span>
          </div>
        )}
        {open && input.body ? <div className="step-body side-session-text">{input.body}</div> : null}
      </div>
    );
  return (
    <div className="peer-message side-session-card" data-kind="authored" data-author={input.by}>
      <div className="peer-message-head">{AUTHOR_LABEL[input.by]}</div>
      <div className="side-session-note-head">
        <span className="side-session-title">{input.title}</span>
        {input.body ? (
          <button type="button" className="side-session-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide details' : 'Show details'}
          </button>
        ) : null}
      </div>
      {open && input.body ? <div className="side-session-text">{input.body}</div> : null}
    </div>
  );
}
