// Settings → Harnesses → All harnesses: "Install another harness (N)", a card for each supported harness that isn't
// installed (first-class first, then basic ones by name) with its official commands to copy or run. Folded once
// any harness is installed; open when none is; not there when nothing is missing.
import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../../store/panes';
import { toast, useStore } from '../../store/core';
import { presenceKey, type Presence } from '../../session/harness/installable';
import { recheckHarness, refreshInstallTools, useHarnessRuns } from '../../session/harness/harnessRuns';
import { pickBasicBin } from '../../session/harness/basicBin';
import { harnessInfo } from '../../harness/registry';
import type { HarnessId } from '../../harness/types';
import { installLines, packageExecutionBlock } from '../../../shared/harnessInstall.mjs';
import { platform } from '../../lib/platform';
import { errorText } from '../../lib/ignored';
import { BinPathRow } from '../pages/Settings';
import { BasicHarnessIcon, HarnessIcon } from '../harnessPicker/badges';
import { ChevronDown, ChevronUp } from '../ui/icons';
import { InstallLines } from './InstallLines';
import { InstallGuidance } from './InstallGuidance';

function KindIcon({ item }: { item: Presence }) {
  return item.tier === 'first' ? (
    <HarnessIcon h={item.kind as HarnessId} size={20} />
  ) : (
    <BasicHarnessIcon id={item.kind.slice('acp:'.length)} size={20} />
  );
}

/** One harness to install: its commands, its docs, and where to point MoPilot at a copy installed elsewhere. */
function InstallCard({ item }: { item: Presence }) {
  const [locating, setLocating] = useState(false);
  const manual = useStore((s) => (item.tier === 'basic' ? s.prefs.acpBins?.[item.kind.slice('acp:'.length)] : undefined));
  const info = harnessInfo(item.kind);
  const commands = installLines(item.kind, platform, null).length > 0;
  // a first-class harness's CLI location is on its own page; a basic one's is set right here
  const setLocation = () => (item.tier === 'first' ? navigate({ name: 'settings', section: item.kind }) : setLocating(true));
  return (
    <div className="install-card" data-install={item.kind}>
      <div className="install-card-head">
        <KindIcon item={item} />
        <span className="install-name">{item.label}</span>
        <span className="install-vendor">{item.vendor}</span>
      </div>
      <InstallGuidance item={item} commands={commands} onSetLocation={setLocation}>
        {commands && <InstallLines item={item} onSetLocation={setLocation} />}
      </InstallGuidance>
      {locating && (
        <BinPathRow
          name={info?.detect.bins[0] ?? item.kind.slice('acp:'.length)}
          value={manual ?? null}
          onChange={(v) => pickBasicBin(item.kind.slice('acp:'.length), v)}
        />
      )}
    </div>
  );
}

export function InstallHarnesses() {
  // a string from the store, read back here: a selector's new array each time would render without end
  const key = useStore(presenceKey);
  const all = useMemo(() => JSON.parse(key) as Presence[], [key]);
  // a harness with a run under way or a result to show keeps its card until the result is dismissed
  const running = useHarnessRuns((s) => s.runs.map((r) => r.kind).join(' ')).split(' ');
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    refreshInstallTools();
  }, []);
  const missing = all.filter((p) => p.state === 'missing');
  const shown = all.filter((p) => p.state === 'missing' || running.includes(p.kind));
  if (!shown.length) return null;
  // folded unless nothing is installed yet (the first launch without the welcome flow)
  const expanded = open ?? !all.some((p) => p.state === 'present');
  const recheckAll = () => {
    refreshInstallTools();
    for (const p of missing) recheckHarness(p.kind).catch((e) => toast(`Couldn't check for ${p.label}: ${errorText(e)}`, 'error'));
  };
  return (
    <section className="settings-group install-harnesses">
      <button type="button" className="install-fold" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        Install another harness ({missing.length})
      </button>
      {expanded && (
        <>
          <p className="settings-lead">
            {packageExecutionBlock(platform)
              ? 'Copy a command and run it in your terminal.'
              : 'Run a command here or in your own terminal.'}{' '}
            MoPilot picks the harness up once it's installed.
          </p>
          <div className="settings-card install-cards">
            {shown.map((p) => (
              <InstallCard key={p.kind} item={p} />
            ))}
          </div>
          <div className="install-foot">
            <button type="button" className="text-link" onClick={recheckAll}>
              Re-check all
            </button>
          </div>
        </>
      )}
    </section>
  );
}
