// A sign-in waiting on a login elsewhere (a browser page the harness opened): what it waits for, and Cancel.
import { Spinner } from '../ui/icons';

export function SignInWaiting({ text, onCancel, buttonClass = 'btn-pill' }: { text: string; onCancel: () => void; buttonClass?: string }) {
  return (
    <div className="signin-waiting" role="status">
      <Spinner size={13} />
      <span>{text}</span>
      <button type="button" className={buttonClass} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
