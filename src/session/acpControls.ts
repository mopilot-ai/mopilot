// A basic harness's composer controls, from whatever its ACP session declares: its modes (session modes or a mode
// config option, split into the permission rows its quirks name and the agent's own modes) and its other config options (model, effort,
// …). Before a chat's session opens they come from the harness's catalog, on the choices its transcript recorded or,
// for a new chat, on the defaults new chats start with.
import { useEffect, useMemo, useState } from 'react';
import { native, type AcpCatalog, type AcpConfigOption, type AcpSessionState } from '../lib/native';
import { ignoring } from '../lib/ignored';
import type { BasicDefaults } from '../store/types';
import { get as getState, setPrefs, useStore } from '../store/core';
import { nativeOf } from '../store/chats';
import { useSessionField } from '../store/session/useSession';
import { acpModeControl, selectValues, type AcpModeControl } from '../../shared/acpMode.mjs';
import { acpSessionOf } from '../harness/acpSessions';
import { setAcpConfig, setAcpMode } from './harness/acp';

export interface BasicSelection {
  /** from the chat's open session, rather than the harness's catalog */
  live: boolean;
  /** whether the harness has said what it offers, even nothing (a session, or the catalog of an admitted harness) */
  known: boolean;
  /** config options other than the mode: the model picker's groups */
  options: AcpConfigOption[];
  mode: AcpModeControl | null;
}

const offered = (o: AcpConfigOption, value: unknown) => o.type !== 'select' || selectValues(o).some((v) => v.value === value);

/** The catalog as the chat would open: each option on the chat's choice, when still offered. */
function withDefaults(catalog: AcpCatalog, defaults: BasicDefaults | undefined): AcpCatalog {
  const configOptions = (catalog.configOptions ?? []).map((o) => {
    // a transcript records a mode set through its option as that option's value
    const want = o.category === 'mode' ? (defaults?.config?.[o.id] ?? defaults?.mode) : defaults?.config?.[o.id];
    return want !== undefined && offered(o, want) ? { ...o, currentValue: want } : o;
  });
  const modes = catalog.modes;
  const mode = defaults?.mode;
  const pick = modes && mode && modes.availableModes.some((m) => m.id === mode) ? { ...modes, currentModeId: mode } : modes;
  return { modes: pick, configOptions: catalog.configOptions ? configOptions : null };
}

/**
 * What the composer offers for a basic chat: its session's declarations, else the catalog with the defaults. A null
 * catalog is a harness that declared nothing; undefined, one not checked yet.
 */
export function basicSelection(
  live: Pick<AcpSessionState, 'modes' | 'configOptions'> | null | undefined,
  catalog: AcpCatalog | null | undefined,
  defaults?: BasicDefaults,
): BasicSelection {
  const fromLive = !!(live && (live.modes || live.configOptions));
  const src = fromLive ? live : catalog ? withDefaults(catalog, defaults) : null;
  return {
    live: fromLive,
    known: fromLive || catalog !== undefined,
    options: (src?.configOptions ?? []).filter((o) => o.category !== 'mode'),
    mode: acpModeControl(src),
  };
}

const NONE: BasicDefaults = {};

/**
 * A chat whose session isn't open but can reopen shows the choices its transcript recorded, which main reopens it on
 * (the agent's own values until they are read); a new chat shows the harness's defaults.
 */
export function useBasicSelection(threadId: string | null, harness: string): BasicSelection {
  const session = useSessionField(threadId, (s) => ({ acp: s.acp }));
  const same = !!threadId && nativeOf(threadId).startsWith(`acp:${harness}:`);
  const live = same ? session.acp : null;
  const catalog = useStore((s) => s.basicHarnesses.find((h) => h.id === harness)?.catalog);
  const defaults = useStore((s) => s.prefs.basicDefaults?.[harness]);
  const key = same ? nativeOf(threadId!) : null;
  const reopens = !!key && !(live?.modes || live?.configOptions) && !!acpSessionOf(key);
  const [recorded, setRecorded] = useState<{ key: string; settings: BasicDefaults } | null>(null);
  useEffect(() => {
    if (!reopens || !key) return;
    // a read for a chat the composer has left since is dropped
    let current = true;
    native.acp
      .recordedSettings(key)
      .then((settings) => current && setRecorded({ key, settings }), ignoring("read a basic chat's recorded settings"));
    return () => {
      current = false;
    };
  }, [reopens, key]);
  const own = reopens ? (recorded?.key === key ? recorded.settings : NONE) : defaults;
  return useMemo(() => basicSelection(live, catalog, own), [live, catalog, own]);
}

export { splitModes, type ModeRow } from '../harness/modeRows';

/** Whether a choice goes to the chat itself: its session is open, or it has one its transcript can reopen. */
const toChat = (threadId: string | null, harness: string, sel: BasicSelection): threadId is string =>
  !!threadId && nativeOf(threadId).startsWith(`acp:${harness}:`) && (sel.live || !!acpSessionOf(nativeOf(threadId)));

function saveDefault(harness: string, patch: (d: BasicDefaults) => BasicDefaults) {
  const all = getState().prefs.basicDefaults ?? {};
  setPrefs({ basicDefaults: { ...all, [harness]: patch(all[harness] ?? {}) } });
}

/**
 * A config value chosen in the picker: the chat's own (applied from its next message), and the default new chats on
 * the harness start with. One the harness refuses changes neither: it keeps the old value and says why.
 */
export async function chooseBasicConfig(threadId: string | null, harness: string, sel: BasicSelection, configId: string, value: unknown) {
  if (toChat(threadId, harness, sel) && !(await setAcpConfig(threadId, configId, value))) return false;
  saveDefault(harness, (d) => ({ ...d, config: { ...d.config, [configId]: value } }));
  return true;
}

/** A mode chosen in the permission menu or the agent's mode menu, for the chat and new chats alike, through whichever call the harness takes. */
export async function chooseBasicMode(threadId: string | null, harness: string, sel: BasicSelection, modeId: string) {
  const control = sel.mode;
  if (toChat(threadId, harness, sel) && control) {
    const ok = control.via === 'config' ? await setAcpConfig(threadId, control.configId!, modeId) : await setAcpMode(threadId, modeId);
    if (!ok) return false;
  }
  saveDefault(harness, (d) => ({ ...d, mode: modeId }));
  return true;
}
