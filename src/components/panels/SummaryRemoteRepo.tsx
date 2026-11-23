// The summary's changes group for a chat on a machine: the repository's branch changes as the machine's Host read them (src/lib/hostRepo.ts), or why there are none to show. No pull request row: GitHub is read from this Mac, not from the machine.
import type { ChatMachine } from '../../lib/chatMachine';
import type { RemoteRepo } from '../../lib/hostRepo';
import { MachineFolderNote, MachineNotice } from './MachineFolderNote';
import { SummaryBranchChanges } from './SummaryChanges';

export function SummaryRemoteRepo({ machine, repo }: { machine: ChatMachine; repo: RemoteRepo | null }) {
  if (machine.away || !repo) return <MachineFolderNote machine={machine} what="Branch and changes" />;
  if (repo.state === 'unavailable') return <MachineNotice text={repo.notice} hostId={machine.id} />;
  if (repo.state !== 'ready') return null;
  return <SummaryBranchChanges totals={repo} />;
}
