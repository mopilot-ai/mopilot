// On a harness's page (under its header, or in a basic harness's details): the version of the binary chats run, its
// update (HarnessUpdate.tsx: the "Update to X" pill and what follows it) and what updates it, or why MoPilot can't.
// How it was installed reads as on its Version row: both name it with sourceOfBin from the same binary.
import { useEffect, useRef } from 'react';
import { sourceOfBin, type HarnessBinary } from '../../lib/cliSource';
import { copyText } from '../../session/clipboard';
import { checkHarnessUpdates, useHarnessUpdates, type HarnessVersionInfo } from '../../harness/harnessUpdates';
import { UpdateFlow, UpdatePill, useHarnessUpdate } from './HarnessUpdate';
import { recheckHarness } from '../../session/harness/harnessRuns';
import { toastFailure } from '../../store/core';
import { manualUpdateCommand } from '../../../shared/harnessInstall.mjs';

/** The line under the version: where it is from (`source`, as its Version row says it) and how it updates, or why it doesn't. */
export function sourceLine(v: HarnessVersionInfo, source: string): string {
  if (v.latest && (v.latestStatus === 'knownBad' || v.latestStatus === 'tooOld') && v.latest !== v.installed)
    return `${v.latest} is out but doesn't work with MoPilot yet`;
  if (v.blockedReason === 'app-bundle') return `${source}: updates with the app`;
  if (v.blockedReason === 'version-manager') return `${source}: update it with your version manager`;
  if (v.blockedReason === 'needs-admin') return `Needs admin rights: run ${v.command} yourself`;
  if (v.blockedReason === 'unknown-install') return `${source}: update it the way you installed it`;
  if (v.blockedReason === 'manual-terminal') return 'Run the update command in your terminal, then re-check.';
  if (v.updatable) return `Updates with ${v.command}`;
  if (!v.latest) return `${source} · couldn't check for a newer version`;
  return `Up to date · ${source}`;
}

/**
 * `binary`: the one chats run, with the installs found and the path the user set, as its Version row has them.
 * `version`: false where the page already says the version (a basic harness's Version row).
 */
export function HarnessVersionLine({
  kind,
  label,
  binary,
  version = true,
}: {
  kind: string;
  label: string;
  binary: HarnessBinary;
  version?: boolean;
}) {
  const u = useHarnessUpdate(kind, label);
  const checking = useHarnessUpdates((s) => s.checking);
  // main's last check was of another binary (the user just chose one) and says nothing about this one
  const stale = u && binary.bin && u.v.bin !== binary.bin ? `${binary.bin}\n${u.v.bin}` : null;
  const asked = useRef(new Set<string>());
  useEffect(() => {
    // in step again: a later choice of the same binary asks again
    if (!stale) return void asked.current.clear();
    // ask main to read the one chats run, once: after any check under way, whose answer may predate the choice. A
    // fresh answer that still names another binary would only say so again
    if (checking || asked.current.has(stale)) return;
    asked.current.add(stale);
    void checkHarnessUpdates();
  }, [stale, checking]);
  // nothing until main has checked it (or while the page doesn't know which binary runs yet)
  if (!u || u.v.bin !== binary.bin) return null;
  const { v } = u;
  const source = sourceOfBin(binary.bin, { ...binary, checked: v }) ?? 'Installed manually';
  return (
    <div className="hver" data-harness-version={kind}>
      <div className="hver-line">
        {version && <span className="hver-version">{v.installed ?? 'Version unknown'}</span>}
        <UpdatePill u={u} />
        <span className="hver-sub" title={v.bin}>
          {sourceLine(v, source)}
        </span>
        {(v.blockedReason === 'needs-admin' || v.blockedReason === 'manual-terminal') && manualUpdateCommand(v) && (
          <button type="button" className="text-link" onClick={() => copyText(v.command!, 'Copied command')}>
            Copy
          </button>
        )}
        {v.blockedReason === 'manual-terminal' && (
          <button
            type="button"
            className="text-link"
            onClick={() =>
              void recheckHarness(kind)
                .then(() => checkHarnessUpdates(true))
                .catch(toastFailure(`Couldn't check for ${label}`))
            }
          >
            Re-check
          </button>
        )}
      </div>
      <UpdateFlow u={u} />
    </div>
  );
}
