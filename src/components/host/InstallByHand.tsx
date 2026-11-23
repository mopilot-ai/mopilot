// An agent the machine lacks and its Host cannot install: the vendor's command to run on the machine with Copy, else its docs page, and Check again once it is installed there (shared/host/installHelp.mjs).
import { useState } from 'react';
import { native } from '../../lib/native';
import { toast } from '../../store/core';
import { userError } from '../../../shared/userError.mjs';
import { installHelp } from '../../../shared/host/installHelp.mjs';
import { Check, Copy } from '../ui/icons';

/** The command with Copy (or the docs link) and Check again for `agent` on `machine`; nothing for an agent the catalog does not offer. */
export function InstallByHand({ machine, agent, label }: { machine: { name: string; platform?: string }; agent: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const help = installHelp(agent, machine.platform);
  if (!help) return null;
  const check = async () => {
    setBusy(true);
    try {
      await native.host.check();
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="install-by-hand" data-install-by-hand={agent}>
      {help.command && (
        <>
          <code className="install-cmd" title={help.command} aria-label={`Install command for ${label}`}>
            {help.command}
          </code>
          <button
            type="button"
            className="btn-pill icon install-copy"
            title={copied ? 'Copied' : 'Copy command'}
            aria-label={copied ? 'Copied' : `Copy the ${label} command`}
            onClick={() =>
              native.clipboard.write(help.command!).then(
                () => setCopied(true),
                (e) => (setCopied(false), toast(userError(e), 'error')),
              )
            }
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </>
      )}
      {help.docs && (
        <button
          type="button"
          className="text-link"
          onClick={() => void native.shell.openExternal(help.docs!).catch((e) => toast(userError(e), 'error'))}
        >
          Docs ↗
        </button>
      )}
      <button type="button" className="btn-pill soft small" disabled={busy} onClick={() => void check()}>
        {busy ? 'Checking…' : 'Check again'}
      </button>
    </span>
  );
}
