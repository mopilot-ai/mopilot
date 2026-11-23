// Setup's third screen (#2607): "Setting up MoMo", the lines of runSetup's real steps as they finish, or the reason one failed with Try again. MomoSetup draws it only once the work has taken SHOW_AFTER_MS (a setup that finishes sooner goes straight on to the chat, with nothing flashing past) or has failed.
import { Check } from '../../ui/icons';
import { SETUP_STEPS } from './runSetup';
import { Orb } from './Orb';

/** How long the work runs before the screen shows. */
export const SHOW_AFTER_MS = 300;

/** What a step's marker is: done, the one running, or waiting. */
const markOf = (i: number, active: number) => (i < active ? 'done' : i === active ? 'active' : 'waiting');

export function ProgressStep({ step, error, onRetry }: { step: number; error: string | null; onRetry: () => void }) {
  return (
    <section className="momo-setup-main momo-progress" aria-labelledby="momo-progress-title" aria-live="polite">
      <Orb size={88} spin={!error} />
      <div className="momo-progress-text">
        <h1 className="momo-setup-title" id="momo-progress-title">
          {error ? 'Couldn’t set up MoMo' : 'Setting up MoMo'}
        </h1>
        {error ? (
          <p className="momo-setup-lead" role="alert">
            {error}
          </p>
        ) : (
          <p className="momo-setup-lead">This only takes a moment.</p>
        )}
      </div>
      {error ? (
        <button type="button" className="btn primary lg" onClick={onRetry}>
          Try again
        </button>
      ) : (
        <ul className="momo-progress-steps">
          {SETUP_STEPS.map((label, i) => (
            <li key={label} data-mark={markOf(i, step)}>
              <span className="momo-progress-mark">{markOf(i, step) === 'done' ? <Check size={16} strokeWidth={2.4} /> : <span />}</span>
              {label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
