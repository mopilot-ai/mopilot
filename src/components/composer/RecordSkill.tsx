// The composer's "Record a skill" dialog: what is recorded in a line, a warning, and Start. A pill at the top of the screen ends the recording (Done or Discard), and the chat's composer gets it (src/store/watchRecord.ts).
import { useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { Modal } from '../ui/Modal';
import { HOME_KEY } from '../../store/computerHistory';

/** `threadId` null is the new chat's box. */
export function RecordSkill({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const start = () => {
    setStarting(true);
    setError(null);
    native.computer.recordStart(threadId ?? HOME_KEY).then(
      (r) => (r.ok ? onClose() : (setError(r.error), setStarting(false))),
      (e) => (setError(errorText(e)), setStarting(false)),
    );
  };
  return (
    <Modal title="Record a skill" onClose={onClose}>
      <p className="ch-share-note">Your clicks and typing are recorded, then sent to this chat to turn into a repeatable skill.</p>
      <p className="ch-share-note">Don't type passwords or secrets, or show private information, while recording.</p>
      {error && (
        <div className="config-warning" role="alert">
          {error}
        </div>
      )}
      <div className="sketch-foot">
        <button className="btn-pill" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-white" disabled={starting} onClick={start}>
          Start recording
        </button>
      </div>
    </Modal>
  );
}
