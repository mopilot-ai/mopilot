// Why adding a machine failed, in words, with the one thing to do about it: read from the step that failed and what it printed (electron/host/install.cjs), for the Add machine card.
import { NO_GUI_SESSION } from './launchd.mjs';
import { knownHostsName } from './sshDestination.mjs';

/**
 * @typedef {{ kind: 'retry' } | { kind: 'wait' } | { kind: 'copy', label: string, text: string } | { kind: 'daemon', label: string } | { kind: 'account', label: string } | { kind: 'ssh', label: string }} FailureAction `ssh`: switch to the SSH tab (a machine added by command with no relay); `account`: type the machine's user name, on the SSH tab; `wait`: the card checks again by itself and continues once the machine answers; `daemon`: add it again as the system daemon, with the Mac's administrator password
 * @typedef {'name' | 'route' | 'timeout' | 'remoteLoginOff' | 'keyOnly' | 'hostKeyChanged' | 'wrongPassword' | 'declined' | 'other'} FailureCause what is wrong, for a card that offers more than the text: the name, the route, the machine's silence, sshd off, keys only, a changed host key, a refused password, a question left unanswered
 * @typedef {{ title: string, reason: string, action: FailureAction, cause: FailureCause, fingerprint?: string }} Failure `fingerprint`: the host key the machine presented, for a changed key
 */

/** @param {string} s */
const quote = (s) => (/^[\w.@:%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** A line as a sentence, whatever it ended with. @param {string} line */
const sentence = (line) => (line ? (/[.!?]$/.test(line) ? line : `${line}.`) : 'It did not start.');

/** A command that could not be made, said in words and with the way on: a machine added by command needs this app's relay, and a build without one points to the SSH tab. @param {string} error @returns {Failure | null} */
export function explainBootFailure(error) {
  if (/no relay/i.test(error))
    return {
      title: 'Add by command isn’t available',
      reason: 'This app has no relay. Add the machine over SSH instead.',
      action: { kind: 'ssh', label: 'Use SSH' },
      cause: 'other',
    };
  return null;
}

/**
 * @param {{ step: string, output: string, target: string, destination: string, rolledBack?: boolean, publicKey?: string }} o `target` the machine's name as shown, `destination` what ssh connects to, `rolledBack` the install was undone on the machine, `publicKey` this Mac's MoPilot key for a machine that takes keys only
 * @returns {Failure}
 */
export function explainFailure(o) {
  const said = explain(o);
  return { ...said, cause: said.cause ?? 'other' };
}

/**
 * @param {{ step: string, output: string, target: string, destination: string, rolledBack?: boolean, publicKey?: string }} o
 * @returns {Omit<Failure, 'cause'> & { cause?: FailureCause }}
 */
function explain({ step, output, target, destination, rolledBack = false, publicKey }) {
  const text = String(output || '');
  const retry = /** @type {FailureAction} */ ({ kind: 'retry' });
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  if (/host key changed since you last connected/.test(text)) {
    const fingerprint = /Fingerprint now: (SHA256:[A-Za-z0-9+/=]+)/.exec(text)?.[1];
    return {
      title: `${target}’s identity changed`,
      reason: `If you reinstalled it, remove its old key and try again. Otherwise don’t connect.${fingerprint ? ` It now shows ${fingerprint}.` : ''}`,
      action: { kind: 'copy', label: 'Copy command', text: `ssh-keygen -R ${quote(knownHostsName(destination))}` },
      cause: 'hostKeyChanged',
      ...(fingerprint && { fingerprint }),
    };
  }
  const details = /** @type {FailureAction} */ ({
    kind: 'copy',
    label: 'Copy details',
    text,
  });
  if (step === 'connect') {
    // the question ssh asked was not answered (Cancel, or nobody there for 5 minutes): nothing failed on the machine
    if (/no answer was given to ssh/.test(text))
      return {
        title: `You didn’t connect to ${target}`,
        reason: 'The question wasn’t answered.',
        action: retry,
        cause: 'declined',
      };
    if (/Connection refused/i.test(text))
      return {
        title: `Turn on Remote Login on ${target}`,
        reason: 'On a Mac: System Settings → General → Sharing. On Linux: start sshd. Adding continues by itself.',
        action: { kind: 'wait' },
        cause: 'remoteLoginOff',
      };
    if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(text))
      return {
        title: `Can’t find ${target}`,
        reason: 'Check the name, or that both are on the same network.',
        action: retry,
        cause: 'name',
      };
    if (/No route to host|Network is unreachable|Host is down/i.test(text))
      return {
        title: `No route to ${target}`,
        reason: 'Check that it’s on, and that you and it are on the same network or VPN.',
        action: retry,
        cause: 'route',
      };
    // ssh gave up after its own 15 s, or the 2-minute cap on one command ended a connection that had been made: either way the machine did not answer in time, which is not "can't reach"
    if (/timed out|^Timed out\.?$/im.test(text))
      return {
        title: `${target} didn’t answer`,
        reason: 'It didn’t reply in time. Check that it’s on and that a firewall isn’t in the way, then try again.',
        action: retry,
        cause: 'timeout',
      };
    const methods = /Permission denied \(([^)]*)\)/.exec(text)?.[1];
    if (methods !== undefined && !/password|keyboard-interactive/.test(methods))
      return publicKey
        ? {
            title: `${target} only takes keys`,
            reason: 'Add this Mac’s key to its authorized_keys, then add it again.',
            action: { kind: 'copy', label: 'Copy key', text: publicKey },
            cause: 'keyOnly',
          }
        : {
            title: `${target} only takes keys`,
            reason: 'Allow password sign-in on it, or use another account.',
            action: { kind: 'account', label: 'Use another account' },
            cause: 'keyOnly',
          };
    if (/Connection closed by|Connection reset|kex_exchange_identification|Broken pipe/i.test(text))
      return {
        title: `Lost the connection to ${target}`,
        reason: 'It closed the connection. Try again.',
        action: retry,
      };
    if (/Permission denied|Too many authentication failures/i.test(text))
      return {
        title: `${target} didn’t accept the sign-in`,
        reason: 'Check the password, or use another account on that machine.',
        action: { kind: 'account', label: 'Use another account' },
        cause: 'wrongPassword',
      };
    if (/only Linux and macOS/.test(text))
      return {
        title: `MoPilot can’t run on ${target}`,
        reason: first,
        action: details,
      };
  }
  if (/No space left on device|Disk quota exceeded/i.test(text))
    return {
      title: `${target} is out of disk space`,
      reason: 'Free some space in the home folder and try again.',
      action: retry,
    };
  if (step === 'key') {
    // the person said no to the key (or nobody answered): nothing was added to the machine
    if (/chose not to let MoPilot add its key/.test(text))
      return {
        title: `MoPilot needs a key to reconnect to ${target}`,
        reason: 'Without one it can’t reconnect on its own. Add the machine again and allow it, or set up your own ssh key for it.',
        action: retry,
        cause: 'declined',
      };
    // its sshd turned the key away: only a setting on the machine changes that
    if (/still won't sign in with it/.test(text))
      return {
        title: `${target} won’t sign in with MoPilot’s key`,
        reason: 'Its sshd refuses keys. Allow PubkeyAuthentication on it, then add it again.',
        action: details,
      };
    return {
      title: `Couldn’t set up sign-in for ${target}`,
      reason: first,
      action: retry,
    };
  }
  if (step === 'node') {
    if (/64-bit Intel or ARM/.test(text))
      return {
        title: `MoPilot can’t run on ${target}`,
        reason: first,
        action: details,
      };
    if (/glibc/.test(text))
      return {
        title: `${target}’s Linux is too old`,
        reason: `Install Node ${/no Node (\d+)/.exec(text)?.[1] ?? 22} on it, or use a newer Linux. Then try again.`,
        action: retry,
      };
    if (/^Neither this Mac nor the machine could get Node/.test(first))
      return {
        title: `${target} can’t get Node`,
        reason: 'Neither this Mac nor it could download Node. Check its internet and try again.',
        action: retry,
      };
    return {
      title: `Couldn’t set up Node on ${target}`,
      reason: first,
      action: retry,
    };
  }
  if (step === 'prepare') {
    if (/has no Host build/.test(text))
      return {
        title: `MoPilot has no Host for ${target}`,
        reason: first,
        action: details,
      };
    return {
      title: `Couldn’t prepare the Host for ${target}`,
      reason: first,
      action: retry,
    };
  }
  if (step === 'upload' || step === 'verify' || step === 'unpack') {
    const reason = /Timed out/i.test(text)
      ? 'The connection is too slow. Try again.'
      : step === 'verify'
        ? 'The file arrived damaged. Try again.'
        : first;
    return {
      title: `Couldn’t copy MoPilot to ${target}`,
      reason,
      action: retry,
    };
  }
  // a Mac nobody is signed in on refuses the user's agent (shared/host/launchd.mjs): the Host can start as the system daemon instead
  const daemon = /** @type {FailureAction} */ ({ kind: 'daemon', label: 'Enter password' });
  if (step === 'start' && text.includes(NO_GUI_SESSION))
    return {
      title: `Nobody is signed in on ${target}`,
      reason: 'An administrator password lets it start anyway.',
      action: daemon,
    };
  if (step === 'daemon')
    return {
      title: `Couldn’t keep ${target} running without sign-in`,
      reason: first,
      action: daemon,
    };
  // a failed step after the files went on undoes the install (electron/host/install.cjs): the card says so
  if (step === 'unit') {
    if (!rolledBack)
      return {
        title: `Couldn’t set up the service on ${target}`,
        reason: first,
        action: retry,
      };
    return {
      title: `Couldn’t set up the service on ${target}`,
      reason: `${sentence(first)} The install was undone.`,
      action: retry,
    };
  }
  if (step === 'start' || step === 'status')
    return rolledBack
      ? {
          title: `MoPilot didn’t start on ${target}`,
          reason: `${sentence(first)} The install was undone.`,
          action: retry,
        }
      : {
          title: `MoPilot installed but didn’t start on ${target}`,
          reason: first,
          action: retry,
        };
  return {
    title: `Couldn’t install on ${target}`,
    reason: first,
    action: retry,
  };
}
