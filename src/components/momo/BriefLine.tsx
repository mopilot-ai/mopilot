// A line of MoMo's morning brief in its chat (A7): MoMo's words as a plain line (a greeting, the one attention item, the lead-in), or, for a suggestion, its card with the title, the source line and Hide and Start. Both are the user's own presses on the Mac (momoSuggestions:act): Hide removes the suggestion, Start sends its first step to MoMo as the user's message. What became of the suggestion shows in place of the buttons and is read from the Mac's store (Started, Hidden, or Done for one that expired or went), so a card reads the same after the chat is reopened or on another window; only a press made here shows at once, before the read comes back.
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { briefCardOf } from '../../../shared/momoBriefNote.mjs';
import { native } from '../../lib/native';
import { errorText, noteIgnored } from '../../lib/ignored';

const WORDS = { start: 'Started', hide: 'Hidden' } as const;

export function BriefLine({ text, suggestion }: { text: string; suggestion?: unknown }) {
  const card = briefCardOf(suggestion);
  const id = card?.id ?? null;
  /** what the store says became of it: null while it waits (or before the first read) */
  const [stored, setStored] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = () =>
      native.momoSuggestions.list().then(
        (r) => {
          if (!live) return;
          // suggestions are off: the card is only the brief's line
          setOff(!r.ok && r.reason === 'unavailable');
          if (!r.ok) return;
          const done = r.done?.[id];
          setStored(done ? WORDS[done] : r.suggestions.some((s) => s.id === id) ? null : 'Done');
        },
        (e) => noteIgnored('read what became of a brief’s suggestion', e),
      );
    void read();
    const stop = native.momoSuggestions.onChanged(() => void read());
    return () => {
      live = false;
      stop();
    };
  }, [id]);
  if (!card || off)
    return (
      <div className="step-row status-note brief momo-brief">
        <span className="step-text">{text}</span>
      </div>
    );
  const act = async (action: 'hide' | 'start') => {
    setError(null);
    try {
      const r = await native.momoSuggestions.act(card.id, action);
      if (r.ok) setPressed(WORDS[action]);
      else if (r.reason === 'gone') setPressed('Done');
      else setError(r.error);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const state = stored ?? pressed;
  return (
    <div className="step-row status-note brief momo-brief" data-brief-card={card.id}>
      <span className="step-icon">
        <Sparkles size={16} strokeWidth={1.6} />
      </span>
      <span className="step-text">
        {card.title}
        {card.source && <span className="momo-nudge-why">{card.source}</span>}
        <span className="momo-nudge-actions">
          {state ? (
            <span className="applies-to momo-chip expired">{state}</span>
          ) : (
            <>
              <button className="btn-pill soft" aria-label={`Hide ${card.title}`} onClick={() => void act('hide')}>
                Hide
              </button>
              <button className="btn-pill" aria-label={`Start ${card.title}`} onClick={() => void act('start')}>
                Start
              </button>
            </>
          )}
        </span>
        {error && <span role="alert">{error}</span>}
      </span>
    </div>
  );
}
