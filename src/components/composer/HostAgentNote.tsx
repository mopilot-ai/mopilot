// The line above a new chat's composer when the machine can't run the agent picked: why, Install on the machine when its Host can install the agent, else the vendor's own command to run there (InstallByHand.tsx). An agent installed there but signed out is signed in from the sign-in card above the composer (HostSigninCard.tsx), never from here.
import { useHostInstall } from './hostInstall';
import type { HostAgentView } from '../../session/useHostAgentChoice';
import { InstallByHand } from '../host/InstallByHand';

export function HostAgentNote({ view }: { view: HostAgentView }) {
  const { machine, choice } = view;
  const blocked = choice!.blocked;
  // the agent is missing and the machine's Host installs it itself: one click, then the sign-in card takes over
  const install = useHostInstall(machine, blocked?.id);
  // missing, and its Host cannot install it (the catalog has no npm line): the vendor's own command or page, run on the machine by hand
  const byHand = !install && machine && blocked?.state === 'missing' ? blocked : null;
  // the agent only needs a sign-in: the sign-in card above says so, names the agent new chats start on meanwhile and signs it in, so this line would only repeat it
  if (blocked?.state === 'signin' && !install) return null;
  return (
    <div className="switch-chip routing-chip" data-host-agent-note>
      <span>{install?.line || choice!.note}</span>
      {byHand && <InstallByHand machine={machine!} agent={byHand.id} label={byHand.label} />}
      {install && (
        <button className="btn-pill" onClick={install.act}>
          {install.label}
        </button>
      )}
    </div>
  );
}
