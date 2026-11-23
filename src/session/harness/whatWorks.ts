// "What works in MoPilot" on a harness's Settings page (#1385): five plain items from what main says a new chat on
// that harness gets (electron/session/harnessCaps.cjs), each a ✓ or what to do instead. The tier and the caps decide,
// never the harness's name; a basic harness's mode names come from its admission catalog, as the composer shows them.
import { useEffect, useState } from 'react';
import { capabilityReasonText } from '../../../shared/capabilityReasons.mjs';
import { acpModeControl } from '../../../shared/acpMode.mjs';
import { native, type AcpCatalog, type NativeSurfaceStatus } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import { useEffectOn } from '../../lib/effects';
import { useStore } from '../../store/core';
import { startCaps, useCapsStore } from '../../store/session/useCaps';
import type { CapView, HarnessCaps } from '../../store/session/capsTypes';
import type { PermissionMode } from '../../store/types';
import type { HarnessKind, Semantic } from '../../harness/adapter';
import { whyText } from '../../harness/caps';
import { splitModes } from '../../harness/modeRows';
import { PERMISSION_LABEL, PERMISSION_ORDER } from '../../harness/permissionsMenu';
import { HARNESS_IDS, HARNESS_LABEL } from '../../harness/types';

export type WorkId = 'chat' | 'permissions' | 'agentModes' | 'images' | 'tools' | 'control';
export interface WorkItem {
  id: WorkId;
  text: string;
  ok: boolean;
  /** under an item that doesn't work: why, and what to do instead */
  note: string | null;
  /** Opens the existing settings page, without changing any permission. */
  action?: 'computer';
}

/** A basic harness's modes as its admission saw them, and the composer's rows they stand for. */
export interface BasicModes {
  catalog?: AcpCatalog | null;
  permissionModes?: Record<string, PermissionMode>;
  agentModes?: string[];
}

const usable = (c: CapView | undefined) => c?.state === 'native' || c?.state === 'sage';
/** Computer use on this Mac, as Settings → Computer use shows it for the harness: what keeps it from working, else null. */
const computerBlock = (s: NativeSurfaceStatus | null | undefined) =>
  s && (s.state === 'unavailable' || s.state === 'permissions') ? capabilityReasonText(s.reasonCode) : null;
const OFF = 'Turned off by MoPilot for now. It comes back on its own.';

/** The composer's names for the permission modes a chat on this harness offers, in its permission menu's order. */
export function permissionNames(c: HarnessCaps, basic?: BasicModes): string[] {
  // a first-tier harness maps all four rows onto its own settings (permissionsMenu.ts)
  if (c.tier === 'first') return PERMISSION_ORDER.map((m) => PERMISSION_LABEL[m]);
  const control = acpModeControl(basic?.catalog);
  return control ? [...new Set(splitModes(control, basic?.permissionModes, basic?.agentModes).permission.map((r) => r.label))] : [];
}

/** A basic harness's own modes (its quirks' agentModes), apart from how much it may do; none on a first-tier harness. */
export function agentModeNames(c: HarnessCaps, basic?: BasicModes): string[] {
  const control = c.tier === 'basic' ? acpModeControl(basic?.catalog) : null;
  return control ? splitModes(control, basic?.permissionModes, basic?.agentModes).agent.map((r) => r.label) : [];
}

/**
 * @param c what main says a new chat on the harness gets
 * @param label the harness's name
 * @param basic a basic harness's modes (its admission entry)
 * @param computer its computer-use status on this Mac (useNativeAvailability's row for its family)
 */
export function whatWorks(c: HarnessCaps, label: string, basic?: BasicModes, computer?: NativeSurfaceStatus | null): WorkItem[] {
  const others = HARNESS_IDS.filter((h) => h !== c.kind)
    .map((h) => HARNESS_LABEL[h])
    .join(' or ');
  /**
   * Why an item a harness doesn't have isn't there, and where to go instead. `tier`: no basic harness has it (MoPilot's
   * own surfaces), rather than this one lacking it.
   */
  const missing = (plural: boolean, tier = false) =>
    `Not available on ${tier && c.tier === 'basic' ? 'basic harnesses' : label} yet. Switch the chat to ${others} for ${plural ? 'these' : 'this'}.`;
  /** The note under a semantic that can't be used: the harness lacks it, or a later layer's reason. */
  const noteOf = (cap: CapView | undefined, semantic: Semantic, plural = false, tier = false) =>
    !cap?.why || cap.why.layer === 'harness' ? missing(plural, tier) : whyText(cap.why, { label, semantic });
  const modes = permissionNames(c, basic);
  const agentModes = agentModeNames(c, basic);
  // the caps decide; the names are said when known
  const permissions = usable(c.caps.permissions);
  // the in-app browser and your Chrome are one surface (browser), computer use the other; both come over the tool channel
  const control = (['browser', 'computerUse'] as const).find((s) => !usable(c.caps[s]));
  const controlNote = control
    ? noteOf(c.caps[control], control, true, true)
    : !c.works.tools
      ? capabilityReasonText(c.works.toolsOffCode)
      : computerBlock(computer);
  return [
    { id: 'chat', text: 'Chat, file edits and terminal commands', ok: c.works.chat, note: c.works.chat ? null : OFF },
    {
      id: 'permissions',
      text: permissions && modes.length ? `Permission modes: ${modes.join(', ')}` : 'Permission modes',
      ok: permissions,
      note: permissions ? null : noteOf(c.caps.permissions, 'permissions'),
    },
    // only where the agent offers its own modes, apart from the permission modes (#1875)
    ...(agentModes.length ? [{ id: 'agentModes' as const, text: `Agent modes: ${agentModes.join(', ')}`, ok: true, note: null }] : []),
    {
      id: 'images',
      text: 'Images in your messages',
      ok: c.works.images === true,
      note: c.works.images === true ? null : c.works.images === null ? 'MoPilot hasn’t checked this yet.' : missing(false),
    },
    {
      id: 'tools',
      text: 'MoPilot tools: messages to other chats, scheduled tasks',
      ok: c.works.tools,
      note: c.works.tools ? null : capabilityReasonText(c.works.toolsOffCode),
    },
    {
      id: 'control',
      text: 'Built-in browser, computer use and your Chrome',
      ok: !controlNote,
      note: controlNote,
      // Computer use settings, unless MoPilot turned it off (then that page is hidden and holds nothing to change)
      ...(!control && c.works.tools && controlNote && computer?.reasonCode !== 'computer.off' ? { action: 'computer' as const } : {}),
    },
  ];
}

/** The harness's admission entry; undefined for a harness admission doesn't check. */
const entryOf = (kind: HarnessKind) => (s: ReturnType<typeof useStore.getState>) => s.basicHarnesses.find((b) => `acp:${b.id}` === kind);

/**
 * What main says a new chat on `kind` gets, asked again when capabilities, the harness's admission or the capability
 * health change; null until it answers. The newest ask wins: one for a harness the page has left, or an older one, is
 * dropped.
 */
export function useHarnessCaps(kind: HarnessKind): HarnessCaps | null {
  const gen = useCapsStore((s) => s.gen);
  // what its checklist reads of its admission, cheap to compare on every store update; a new admission list asks again
  const state = useStore((s) => entryOf(kind)(s)?.state);
  const images = useStore((s) => entryOf(kind)(s)?.images);
  const catalog = useStore((s) => entryOf(kind)(s)?.catalog);
  const [got, setGot] = useState<{ kind: HarnessKind; value: HarnessCaps | null } | null>(null);
  // the tool bridge on this Mac (the capability-health record) changes apart from the caps
  const [health, setHealth] = useState(0);
  useEffect(() => native.availability.onChanged(() => setHealth((n) => n + 1)), []);
  useEffectOn([kind, gen, state, images, catalog, health], () => {
    startCaps();
    let current = true;
    native.session.harnessCaps(kind).then((value) => current && setGot({ kind, value }), ignoring("read a harness's capabilities"));
    return () => {
      current = false;
    };
  });
  return got?.kind === kind ? got.value : null;
}
