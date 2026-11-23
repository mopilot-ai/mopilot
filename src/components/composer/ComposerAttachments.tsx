// The composer attachment tray owns selection edits, saved audio playback, previews and removal.
import type { Dispatch, SetStateAction } from 'react';
import type { Attachment } from '../../store/types';
import { AudioMessage } from './AudioMessage';
import { FileText, X } from '../ui/icons';
import { withKeys } from '../../lib/listKeys';
import { SelectionChip } from './SelectionChip';
import { editSelection, removeSelection } from '../../lib/annotations';
export function ComposerAttachments({
  attachments,
  onChange,
  onFocus,
}: {
  attachments: Attachment[];
  onChange: Dispatch<SetStateAction<Attachment[]>>;
  onFocus(): void;
}) {
  return (
    <>
      {attachments.some((a) => a.kind !== 'skill') && (
        <div className="attachments">
          <SelectionChip
            selections={attachments.filter((a) => a.kind === 'selection')}
            onRemove={() => onChange((x) => x.filter((a) => a.kind !== 'selection'))}
            onEdit={(index, annotation) => {
              onChange((items) => editSelection(items, index, annotation));
              // like a new annotation's comment: a second Enter sends the message
              onFocus();
            }}
            onRemoveSelection={(index) => onChange((items) => removeSelection(items, index))}
          />
          {withKeys(attachments, (a) => `${a.kind}:${a.path}`).map(
            ({ key, item: a, index: i }) =>
              a.kind !== 'selection' &&
              a.kind !== 'skill' && (
                <div key={key} className={`attachment ${a.kind}`} title={a.path}>
                  {a.kind === 'audio' ? (
                    <AudioMessage path={a.path} />
                  ) : a.kind === 'image' && a.previewUrl ? (
                    <img src={a.previewUrl} alt={a.name} />
                  ) : (
                    <>
                      <span className="attachment-icon">
                        <FileText size={14} />
                      </span>
                      <span className="attachment-name">{a.name}</span>
                    </>
                  )}
                  <button className="attachment-remove" onClick={() => onChange((x) => x.filter((_, j) => j !== i))} aria-label="Remove">
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </div>
              ),
          )}
        </div>
      )}
    </>
  );
}
