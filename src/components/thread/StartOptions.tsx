// Proposed session controls: placement, harness and available model settings stay on the card until main claims Start.
import { useEnabledHarnesses } from '../../lib/flags';
import { HARNESS_LABEL } from '../../../shared/handoff.mjs';
import type { SideSessionProposal } from '../../../shared/orchestration';
import { NOT_A_REPO } from '../../../shared/worktreeSupport.mjs';
import { chatKind } from '../../store/chats';
import { useStore } from '../../store/core';
import { StartConfigOptions } from './StartConfigOptions';

export type StartChoice = {
  harness: string | null;
  useWorktree: boolean | null;
  model?: string | null;
  effort?: string | null;
  permission?: string | null;
};

/**
 * Where a proposal runs as its card says it: as proposed, or in the chat's folder when that folder can't hold a
 * worktree (`noWorktree`, worktreeUnsupported's reason), where main starts it instead (spawn.cjs makeChild).
 */
export function placeOf(place: SideSessionProposal['place'], noWorktree: string | null | undefined): SideSessionProposal['place'] {
  return noWorktree && place === 'worktree' ? 'folder' : place;
}

/** What the card sends with Start: only what the user changed, or nothing. */
export function startChoice(
  choice: StartChoice,
): { harness?: string; useWorktree?: boolean; model?: string; effort?: string; permission?: string } | null {
  const out: { harness?: string; useWorktree?: boolean; model?: string; effort?: string; permission?: string } = {};
  if (choice.harness) out.harness = choice.harness;
  if (choice.useWorktree != null) out.useWorktree = choice.useWorktree;
  if (choice.model) out.model = choice.model;
  if (choice.effort) out.effort = choice.effort;
  if (choice.permission) out.permission = choice.permission;
  return Object.keys(out).length ? out : null;
}

export function StartOptions({
  proposal,
  choice,
  onChange,
  noWorktree = null,
}: {
  proposal: SideSessionProposal;
  choice: StartChoice;
  onChange: (next: StartChoice) => void;
  /** why the chat's folder can't hold a worktree (worktreeUnsupported), or null when it can or isn't known yet */
  noWorktree?: string | null;
}) {
  const harnesses = useEnabledHarnesses();
  const basics = useStore((s) => s.basicHarnesses);
  const kind = useStore((s) => choice.harness ?? chatKind(proposal.parentId, s));
  // A fork inherits its placement; this switch applies only to fresh sessions. Outside a git repo there is no choice
  // (a repo with no commits keeps the switch, off, and says why).
  const shown = proposal.place !== 'fork' && noWorktree !== NOT_A_REPO;
  const worktree = !noWorktree && (choice.useWorktree ?? proposal.place === 'worktree');
  return (
    <div className="start-options" role="group" aria-label="Start options">
      {shown && (
        <label
          className={`start-option ${noWorktree ? 'disabled' : ''}`}
          title={noWorktree ? `Worktree unavailable: ${noWorktree}` : undefined}
        >
          <input
            type="checkbox"
            checked={worktree}
            disabled={!!noWorktree}
            onChange={(e) => onChange({ ...choice, useWorktree: e.target.checked })}
          />
          Its own worktree
        </label>
      )}
      <label className="start-option">
        Harness
        <select
          value={choice.harness ?? ''}
          onChange={(e) => onChange({ ...choice, harness: e.target.value || null, model: null, effort: null, permission: null })}
        >
          <option value="">As proposed</option>
          {harnesses.map((h) => (
            <option key={h} value={h}>
              {HARNESS_LABEL[h]}
            </option>
          ))}
          {basics
            .filter((h) => h.state === 'admitted')
            .map((h) => (
              <option key={h.id} value={`acp:${h.id}`}>
                {h.label ?? h.id}
              </option>
            ))}
        </select>
      </label>
      <StartConfigOptions kind={kind} parentId={proposal.parentId} choice={choice} onChange={onChange} />
    </div>
  );
}
