// The existing pane Stop control uses main so an agent's active load wait receives an explicit interruption.
import { native } from './native';
import { errorText } from './ignored';
import { isCertificateError, loadFailure } from '../../shared/browserNotice.mjs';
import { netErrorMessage, netErrorName } from '../../shared/netErrors.mjs';

/**
 * A load the pane started failed: Chrome's words for a known error (an untrusted certificate keeps its own recovery),
 * else `fallback`; the raw error stays as the notice's detail.
 */
export function browserLoadFailure(error: unknown, fallback: string): { message: string; reason: string; detail?: string } {
  const name = netErrorName(null, errorText(error));
  if (isCertificateError(null, name) || netErrorMessage(name)) return loadFailure(0, name);
  return { message: fallback, reason: 'load', detail: name || undefined };
}
/** A newer load or Stop cut this one short: nothing went wrong with the page. */
export const loadWasAborted = (error: unknown) => errorText(error).includes('ERR_ABORTED');
export function stopBrowserLoad(page: { getWebContentsId(): number } | null, failed: () => void) {
  try {
    if (!page) return failed();
    native.browser.stopLoading(page.getWebContentsId()).catch(failed);
  } catch {
    failed();
  }
}
