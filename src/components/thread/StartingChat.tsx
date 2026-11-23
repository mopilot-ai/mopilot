// Immediate submitted-message feedback while a new chat's folder and native session are being created.
import { useRef } from 'react';
import type { Attachment } from '../../store/types';
import type { ActivityUx } from '../../session/activityUx';
import { withKeys } from '../../lib/listKeys';
import { FoldedText } from '../ui/FoldedText';
import { MessageImages } from './view/MessageImages';
import { ClaudeActivity } from './ClaudeActivity';
import { ActivityTime } from './ActivityTime';
import { Shimmer, useNow } from './items/presentation';

export interface StartingChatProps {
  text: string;
  attachments: Attachment[];
  ux: ActivityUx;
}

export function StartingChat({ text, attachments, ux }: StartingChatProps) {
  const now = useNow(true);
  const started = useRef(now);
  const elapsed = Math.max(0, now - started.current);
  const images = attachments.filter((a) => a.kind === 'image');
  const others = attachments.filter((a) => a.kind !== 'image');
  return (
    <div className="new-chat-starting" aria-busy="true">
      <div className="turn item-enter">
        <div className="user-message">
          {/* the pictures as the sent message will show them, never as their "Pasted image" name */}
          <MessageImages images={images.map((a) => ({ src: a.previewUrl, path: a.path }))} pending />
          {others.length > 0 && (
            <div className="user-mentions">
              {withKeys(others, (a) => JSON.stringify([a.kind, a.path])).map(({ key, item }) => (
                <span className="mention-chip" key={key}>
                  {item.kind === 'file' ? `@${item.name}` : item.name}
                </span>
              ))}
            </div>
          )}
          {text && (
            <div className="user-bubble">
              <FoldedText text={text} />
            </div>
          )}
        </div>
        {ux === 'dots' ? (
          <ClaudeActivity label="Starting chat" activity="think" elapsedMs={elapsed} />
        ) : (
          <div className="step-row active" role="status">
            <Shimmer>Starting chat</Shimmer>
            <ActivityTime elapsedMs={elapsed} />
          </div>
        )}
      </div>
    </div>
  );
}
