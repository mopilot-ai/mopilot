// The user's own MCP servers on a basic harness (#1575): Settings' rows that turn them off for MoPilot's chats only,
// and the note a chat shows when they crowd the model's context, with the same switch one click away.
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { get as getState, setPrefs, useStore } from '../../store/core';
import { nativeOf } from '../../store/chats';
import { useSession } from '../../store/session/useSession';
import { acpHarnessOf } from '../../harness/types';
import { native } from '../../lib/native';
import type { OwnMcpStatus } from '../../lib/native/acp';
import { ignoring } from '../../lib/ignored';
import { crowding, kTokens, withLoad, withServer } from '../../lib/ownMcp';
import { Row, Toggle } from '../pages/settings/Controls';
import { Plug } from '../ui/icons';

/** The harness's own servers as main reads them, read again when the choice changes or `again` does (a turn ended). */
export function useOwnMcp(harness: string | null, again?: unknown): OwnMcpStatus | null {
  const choice = useStore((s) => (harness ? s.prefs.acpMcp?.[harness] : undefined));
  const [status, setStatus] = useState<OwnMcpStatus | null>(null);
  // one read per harness, choice and turn end: each is a new read, since main's answer depends on all three
  const read = useMemo(() => (harness ? { harness, choice, again } : null), [harness, choice, again]);
  useEffect(() => {
    if (!read) return void setStatus(null);
    // a read for a harness this view has left since is dropped
    let current = true;
    native.acp.ownMcp(read.harness).then((s) => current && setStatus(s), ignoring("read a harness's own MCP servers"));
    return () => {
      current = false;
    };
  }, [read]);
  return status?.harness === harness ? status : null;
}

const setLoad = (harness: string, load: boolean) => setPrefs({ acpMcp: withLoad(getState().prefs.acpMcp, harness, load) });
const setServer = (harness: string, name: string, off: boolean) =>
  setPrefs({ acpMcp: withServer(getState().prefs.acpMcp, harness, name, off) });

/** A server MoPilot's gateway runs: its own copy is off in MoPilot's chats (#2999 C4). */
const GATEWAY_RUNS = "MoPilot's MCP gateway runs this server for every chat, under your rules, so this copy is off in MoPilot's chats.";

/** A harness that loads its own servers MoPilot can't switch off: one the gateway runs is loaded twice there. */
export const gatewayNote = (label: string) =>
  `A server MoPilot's MCP gateway runs that is also in ${label}'s settings is also loaded directly by ${label}, and your rules don't apply there.`;

/** When a change reaches the harness: its process restarts once its running turns end. */
const whenApplied = (s: OwnMcpStatus) =>
  s.pending ? `It applies when ${s.label}'s current turns end.` : 'It applies from the next message.';

/** Settings → Other harnesses → a harness: whether MoPilot's chats load its own MCP servers, all or some. */
export function OwnMcpSettings({ harness }: { harness: string }) {
  const s = useOwnMcp(harness);
  if (!s) return null;
  if (!s.supported)
    return (
      <Row
        title="MCP servers from its own settings"
        desc={`${s.label}'s chats load the MCP servers in ${s.label}'s own settings. MoPilot can't turn them off for ${s.label}; turn them off there. ${gatewayNote(s.label)}`}
      />
    );
  return (
    <>
      <Row
        title={`Load MCP servers from ${s.label}'s global settings`}
        desc={`In MoPilot's ${s.label} chats only; your ${s.label} settings stay as they are. Servers a project's own settings add still load.${s.pending ? ` ${whenApplied(s)}` : ''}`}
      >
        <Toggle on={s.load} onChange={(v) => setLoad(harness, v)} />
      </Row>
      {s.servers.map((m) => (
        <Row key={m.name} mono title={m.name} desc={m.managed ? GATEWAY_RUNS : m.enabled ? undefined : `Off in ${s.label}'s own settings`}>
          <Toggle
            on={m.enabled && !m.off && !m.managed}
            disabled={!s.load || !m.enabled || m.managed === true}
            onChange={(v) => setServer(harness, m.name, !v)}
          />
        </Row>
      ))}
    </>
  );
}

/**
 * Under a basic chat's latest turn, when what its harness loads before the conversation crowds the model's context: the
 * MCP servers from the harness's own settings, each one click from turned off for MoPilot's chats.
 */
export function OwnMcpNotice({ threadId }: { threadId: string }) {
  const harness = acpHarnessOf(nativeOf(threadId));
  const usage = useSession(threadId).acp?.usage ?? null;
  const turn = useStore(
    useShallow((s) => {
      const rt = s.runtime[threadId];
      return rt?.turns[rt.turns.length - 1] ?? null;
    }),
  );
  const why = harness ? crowding(turn, usage) : null;
  const s = useOwnMcp(why ? harness : null, turn?.status);
  if (!why || !s) return null;
  const detail =
    why.kind === 'tools'
      ? `This model takes at most ${why.max} tools in a request, and this chat sends more, so it refuses every message.`
      : why.kind === 'loop'
        ? `It compacted its context ${why.count} times in a row without getting further.`
        : `${kTokens(why.used)} of the model's ${kTokens(why.size)}-token window was still in use after ${why.after === 'compacting' ? 'compacting' : 'a turn that only replied'}.`;
  const listed = s.servers.filter((m) => m.enabled);
  const tools = why.kind === 'tools';
  // the failed turn stays the latest until the next message, so a choice made since is not yet tried: say what a refusal
  // with them off would mean
  const OWN_ALONE = " If it is refused again, MoPilot's own tools alone are more than the model accepts.";
  const next = !s.supported
    ? `MoPilot can't turn them off for ${s.label}: turn them off in ${s.label}'s own settings, or ${tools ? 'pick a model that takes more tools' : 'pick a model with a larger context window'}.`
    : !listed.length
      ? `${s.label}'s global settings list no MCP servers to turn off; ${tools ? 'a model that takes more tools would work' : 'a model with a larger context window has more room'}.`
      : `Turn one off for MoPilot's ${s.label} chats only; your ${s.label} settings stay as they are. ${whenApplied(s)}${tools && (!s.load || listed.some((m) => m.off)) ? OWN_ALONE : ''}`;
  return (
    <div className="retry-banner turn-stall own-mcp" role="note">
      <Plug size={13} />
      <div className="turn-stall-text">
        <div>
          {tools
            ? `Tools from MCP servers in ${s.label}'s global settings, with MoPilot's own, are more than the model accepts.`
            : `Tools from MCP servers in ${s.label}'s global settings may be filling the model's context.`}{' '}
          {detail}
        </div>
        <div className="turn-stall-next">{next}</div>
      </div>
      {s.supported && listed.length > 0 && (
        <div className="turn-stall-actions">
          {!s.load ? (
            <button className="btn-pill" onClick={() => setLoad(s.harness, true)}>
              Load them again
            </button>
          ) : (
            listed.map((m) =>
              m.off ? (
                <button key={m.name} className="btn-pill" onClick={() => setServer(s.harness, m.name, false)}>
                  Turn {m.name} back on
                </button>
              ) : (
                <button key={m.name} className="btn-pill primary" onClick={() => setServer(s.harness, m.name, true)}>
                  Turn off {m.name}
                </button>
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}
