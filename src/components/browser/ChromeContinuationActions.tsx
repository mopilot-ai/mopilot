// Chrome continuation and explicit removal of its retained queue input, before any fresh retry.
import { sendMessage } from '../../store/send';
import type { useChromeContinuation } from '../../lib/useChromeContinuation';

export function ChromeContinuationActions({
  resume,
  chatId,
  label,
  onContinue,
  onRemoved,
}: {
  resume: ReturnType<typeof useChromeContinuation>;
  chatId: string;
  label: string;
  onContinue: () => void;
  onRemoved: (error: string | null) => void;
}) {
  return (
    <>
      <button className="btn-pill primary" disabled={resume.busy || resume.retained} onClick={onContinue}>
        {label}
      </button>
      {resume.retained && (
        <button disabled={resume.busy} onClick={() => void resume.removeRetained(chatId, onRemoved)}>
          Remove queued continuation and retry
        </button>
      )}
    </>
  );
}

/** The pane's continuation uses the same current-route read and main-owned receipt as the chat strip. */
export function ChromeTaskContinue({
  resume,
  chatId,
  url,
  signedIn,
  onSettled,
  onRemoved,
}: {
  resume: ReturnType<typeof useChromeContinuation>;
  chatId: string;
  url: string;
  signedIn: boolean;
  onSettled: (error: string | null) => void;
  onRemoved: (error: string | null) => void;
}) {
  return (
    <ChromeContinuationActions
      resume={resume}
      chatId={chatId}
      label="Continue task in Chrome"
      onContinue={() =>
        void resume.run(
          { chatId, url, signedIn },
          (message, chromeHandoff, received) => sendMessage(chatId, message, [], { human: true, chromeHandoff }, received),
          onSettled,
        )
      }
      onRemoved={onRemoved}
    />
  );
}
