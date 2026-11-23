// What installing a missing agent on a machine says, in plain words, for the Mac's rows and the phone's sheet alike: the state as one short line, the button labels, the sentences for the ways an install ends without the machine's own reason, and the machine's progress text made safe to show.
import { agentLabel } from './agentReadiness.mjs';

/** The longest progress line or error of a machine that is shown. */
export const MAX_TEXT = 500;

/** The labels and sentences of the install controls, said once for every client. */
export const INSTALL_WORDS = Object.freeze({
  install: (/** @type {string} */ name) => `Install ${name}`,
  installing: 'Installing…',
  cancel: 'Cancel',
  retry: 'Try again',
  done: 'Done',
  lost: 'The machine lost the install. Try again.',
  failed: 'The install failed.',
  tooLong: 'The install took too long and was stopped.',
  oldHost: 'Update the Host on this machine to install agents from here.',
});

/** A machine's text, as one bounded line (it is another machine's output, not trusted input); '' for anything that is not text. @param {unknown} v */
export const installText = (v) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, MAX_TEXT)
    : '';

/**
 * What an install says next to its machine: one calm line while it runs, how it ended, else nothing. The Mac's own states.
 * @param {{ state: string, harness: string, error?: string | null } | undefined} view
 */
export function installLine(view) {
  if (!view) return '';
  const name = agentLabel(view.harness);
  if (view.state === 'queued') return `Waiting to install ${name}…`;
  if (view.state === 'running') return `Installing ${name}…`;
  if (view.state === 'checking') return `Checking ${name}…`;
  if (view.state === 'installed') return `${name} installed.`;
  if (view.state === 'cancelled') return '';
  return view.error ?? `Couldn't install ${name}.`;
}

/** The phone's states, in the Mac's words. */
const AS_MAC = {
  starting: 'queued',
  installing: 'running',
  checking: 'checking',
  done: 'installed',
  failed: 'failed',
  unreachable: 'unreachable',
};

/**
 * The phone's install as plain words: null when there is nothing to say (none started, or cancelled); `action` is what the person can do next, `details` the machine's own progress line while it installs.
 * @param {{ state: string, harness: string, error: string | null, line?: string } | undefined} view
 * @returns {{ text: string, action?: 'retry' | 'cancel', details?: string } | null}
 */
export function installStatus(view) {
  if (!view || !Object.hasOwn(AS_MAC, view.state)) return null;
  const text = installLine({ ...view, state: AS_MAC[/** @type {keyof typeof AS_MAC} */ (view.state)] });
  if (view.state === 'starting') return { text, action: 'cancel' };
  if (view.state === 'installing') {
    const line = installText(view.line);
    return { text, action: 'cancel', ...(line && line !== text ? { details: line } : {}) };
  }
  if (view.state === 'failed' || view.state === 'unreachable') return { text, action: 'retry' };
  return { text };
}
