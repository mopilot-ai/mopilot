// Above the composer while a Your Chrome call of the chat waits for the user to approve the connection in Chrome (no saved token): the Playwright Extension's page asks there, so the chat says where to look.
import { CHROME_APPROVAL } from '../../../shared/browser.mjs';
import { Globe } from '../ui/icons';

export function ChromeApprovalNotice() {
  return (
    <div className="elsewhere-notice chrome-link" role="status" data-state="approve">
      <span className="elsewhere-icon">
        <Globe size={14} />
      </span>
      <div className="elsewhere-text">
        <div className="elsewhere-title">Waiting for you in Chrome</div>
        <div className="elsewhere-body">{CHROME_APPROVAL}</div>
      </div>
    </div>
  );
}
