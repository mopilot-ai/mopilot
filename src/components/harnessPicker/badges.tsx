// Harness icons, usage meters, sign-in dispatch and thread identity badges.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useStore } from '../../store/core';
import { navigate } from '../../store/panes';
import { chatFamily, chatBasicHarness } from '../../store/chats';
import { BASIC_HOVER, basicLabel } from '../../session/harness/acp';
import { HARNESS_LABEL, type HarnessId, type HarnessStatus } from '../../harness/types';
import { firstTierOf } from '../../harness/family';
import { Tooltip } from '../ui/Popover';
import { PARTS } from '../harness/parts';
import { LimitMeters } from '../accounts/meters';
import { BASIC_LOGOS } from './logos';
import { hostFamilyOfHarness } from '../../../shared/host/chatIds.mjs';
import { isFirstTier, type HarnessKind } from '../../harness/adapter';

export function HarnessIcon({ h, size = 16 }: { h: HarnessKind; size?: number }) {
  if (!isFirstTier(h)) return <BasicHarnessIcon id={h.slice(4)} size={size} />;
  const Icon = PARTS[h].Icon;
  return <Icon size={size} />;
}

/** A basic harness's mark: its vendor's logo in the text colour, else its initial on a neutral tile. */
export function BasicHarnessIcon({ id, size = 16 }: { id: string; size?: number }) {
  // a chat that runs Claude Code or Codex on a machine wears that agent's mark
  const family = hostFamilyOfHarness(id);
  if (family) return <HarnessIcon h={family} size={size} />;
  const label = basicLabel(id);
  const paths = BASIC_LOGOS[id];
  if (paths)
    return (
      <svg
        className="harness-icon logo"
        role="img"
        aria-label={label}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  return (
    <span
      className="harness-icon basic"
      role="img"
      aria-label={label}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}

/** The Limited badge (a basic harness); its hover says what's different and links to Other harnesses, where each basic harness says what works. */
export function BasicBadge({ id }: { id: string }) {
  return (
    <Tooltip
      label={
        <span className="basic-hover">
          {BASIC_HOVER(basicLabel(id))}{' '}
          <button type="button" className="text-link" onClick={() => navigate({ name: 'settings', section: 'other-harnesses' })}>
            See what's different
          </button>
        </span>
      }
      delay={200}
      interactive
    >
      <span className="hp-badge basic">Limited</span>
    </Tooltip>
  );
}
/** A harness's usage meters, as percent left: "5h ▓▓▓ 82% left" (compact: "82%"). */
export function UsageMeters({ usage, compact = false }: { usage: HarnessStatus['usage']; compact?: boolean }) {
  return <LimitMeters windows={usage?.windows ?? []} variant={compact ? 'compact' : 'inline'} />;
}
/** Start the unmodified CLI's own login flow in a terminal tab; Sage never sees the credentials. */
export function signInHarness(h: HarnessId, chatId?: string | null) {
  return PARTS[h].signIn(chatId);
}
/** Small glyph for sidebar rows and lists. */
export function ThreadHarnessBadge({ threadId }: { threadId: string }) {
  useStore((s) => s.segments[threadId]);
  const h = firstTierOf(chatFamily(threadId));
  if (!h) {
    const basic = chatBasicHarness(threadId)!;
    return (
      <span className="thread-harness" title={basicLabel(basic)}>
        <BasicHarnessIcon id={basic} size={12} />
      </span>
    );
  }
  return (
    <span className="thread-harness" title={HARNESS_LABEL[h]}>
      <HarnessIcon h={h} size={12} />
    </span>
  );
}
