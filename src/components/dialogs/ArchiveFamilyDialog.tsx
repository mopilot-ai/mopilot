// Archive a linked family together or leave the children at top level, using the app's global window-owned choice queue.
import { useEffect, useId } from 'react';
import { answerArchiveFamilyChoice, cancelArchiveFamilyChoices, useArchiveFamilyChoice } from '../../lib/archiveFamilyChoice';
import { imeComposing } from '../../lib/focus';

export function ArchiveFamilyDialog() {
  const request = useArchiveFamilyChoice();
  const label = useId();
  const detail = useId();
  useEffect(() => () => cancelArchiveFamilyChoices(), []);
  if (!request) return null;
  const answer = (choice: 'all' | 'parent' | null) => answerArchiveFamilyChoice(request.id, choice);
  const children = request.total - 1;
  return (
    <div className="sketch-backdrop" onKeyDown={(e) => e.key === 'Escape' && !imeComposing(e) && answer(null)}>
      <div className="dialog acct-dialog" role="alertdialog" aria-labelledby={label} aria-describedby={detail}>
        <div className="dialog-head">
          <span id={label}>Archive session?</span>
        </div>
        <div id={detail} className="acct-dialog-hint">
          <p>
            “{request.title}” has {children === 1 ? 'a nested session' : `${children} nested sessions`}. Archive only this one and{' '}
            {children === 1 ? 'it moves' : 'they move'} to the top level.
          </p>
          {request.working > 0 && (
            <p>
              {request.working === 1
                ? 'A nested session is still working and stops if you archive it too.'
                : `${request.working} nested sessions are still working and stop if you archive them too.`}
            </p>
          )}
        </div>
        <div className="acct-dialog-actions">
          <button className="btn sm" onClick={() => answer(null)}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => answer('all')}>
            Archive {request.total === 2 ? '' : 'all '}
            {request.total} sessions
          </button>
          <button className="btn primary sm" autoFocus onClick={() => answer('parent')}>
            Archive this session
          </button>
        </div>
      </div>
    </div>
  );
}
