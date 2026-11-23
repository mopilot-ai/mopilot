// Above a new chat's composer: where this new chat will go when that is not the plain default, with the
// account it uses and an Undo (WP7-12, D-22, D-23). Codex Cloud, and ⇧⌘N while the default harness is a
// basic-tier one that can't keep a chat off disk (the temporary chat runs on Claude Code instead), and a default
// harness that can't run now (new chats start on another until it can: harness/defaultHarness.ts).
import { clearCloudDestination } from '../../store/repositoryDraft';
import { set as setState, useStore } from '../../store/core';
import { navigate } from '../../store/panes';
import { newChatBasic, newChatHarness, defaultHarness, defaultHarnessFallbackNote } from '../../store/chats';
import { basicIdOf } from '../../harness/defaultHarness';
import { basicLabel } from '../../session/harness/acp';
import { TEMPORARY_BASIC_HARNESS } from '../../harness/family';
import { useHarnessStatus } from '../../session/harness/select';
import { cloudChip, temporaryChip, usesCodexCloud } from '../../harness/entries';
import { useHostAgentChoice } from '../../session/useHostAgentChoice';
import { HostAgentNote } from './HostAgentNote';
import { BasicHarnessIcon, HarnessIcon } from '../harnessPicker/HarnessPicker';

export function RoutingChip() {
  const cloudEnv = useStore((s) => (usesCodexCloud(newChatHarness(s)) ? s.newChatCloudEnv : null));
  const basic = useStore((s) => (s.newChatTemporary ? newChatBasic(s) : null));
  const codex = useHarnessStatus('codex');
  // the harness a temporary chat picked on a basic harness runs on (Claude Code)
  const temp = useHarnessStatus(TEMPORARY_BASIC_HARNESS);
  // the login new Claude Code chats use (the pool's active one), not whichever the last status read named
  const active = useStore((s) => s.claudeAccounts.accounts.find((a) => a.id === s.claudeAccounts.active)?.email ?? null);
  const fallback = useStore((s) => defaultHarnessFallbackNote(s));
  const standIn = useStore((s) => defaultHarness(s).kind);
  const host = useHostAgentChoice();
  // a folder on a machine: that machine's readiness is the whole story, whatever this Mac has signed in
  if (host) return host.choice?.note ? <HostAgentNote view={host} /> : null;
  if (cloudEnv)
    return (
      <div className="switch-chip routing-chip">
        <HarnessIcon h="codex" size={13} />
        <span>{cloudChip(codex.email ?? codex.plan ?? 'signed in')}</span>
        <button className="btn-pill" onClick={clearCloudDestination}>
          Undo
        </button>
      </div>
    );
  if (basic)
    return (
      <div className="switch-chip routing-chip">
        <HarnessIcon h={TEMPORARY_BASIC_HARNESS} size={13} />
        <span>{temporaryChip(active ?? temp.email ?? temp.plan ?? 'signed in', basicLabel(basic))}</span>
        <button className="btn-pill" onClick={() => setState({ newChatTemporary: false })}>
          Undo
        </button>
      </div>
    );
  if (fallback) {
    const basic = basicIdOf(standIn);
    return (
      <div className="switch-chip routing-chip" data-default-fallback>
        {basic ? <BasicHarnessIcon id={basic} size={13} /> : <HarnessIcon h={standIn as 'codex' | 'claude'} size={13} />}
        <span>{fallback}</span>
        <button className="btn-pill" onClick={() => navigate({ name: 'settings', section: 'harnesses' })}>
          Harness settings
        </button>
      </div>
    );
  }
  return null;
}
