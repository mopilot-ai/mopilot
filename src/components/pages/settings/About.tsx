// Settings → About: version, updates (with the ready update's What's new) and the Codex runtime.

import { Group, Row, Toggle, Select } from './Controls';
import { useHarnessStatus } from '../../../session/harness/select';
import { HARNESS_LABEL } from '../../../harness/types';
import { useState } from 'react';
import { useStore, setPrefs, toastFailure } from '../../../store/core';
import { navigate } from '../../../store/panes';
import { native } from '../../../lib/native';
import { copyText } from '../../../session/clipboard';
import { openFile } from '../../../session/open';
import { abbreviateHome } from '../../../lib/paths';
import { CHECK_FOR_UPDATES } from '../../../lib/uiLabels';
import { installLine, sourceOfBin } from '../../../lib/cliSource';
import type { CliCandidate } from '../../../lib/native/contracts/harnesses';
import { HarnessVersionRow } from '../../harness/HarnessVersionRow';
import { useCodexBinaries } from '../../../harness/codexBinaries';
import { useVersionOf } from '../../../harness/harnessUpdates';
import { useUpdateState } from '../../../session/updates';
import { updateDescription, rollbackAction } from '../../../lib/updatePresentation';
import { channelChoice } from '../../../lib/updateChannel';
import { useMoPilot } from '../../../lib/mopilot';
import { MigrationAdvanced } from './MigrationReport';
import { RequestLogAdvanced } from './RequestLog';
import { MATRIX } from '../../../harness/compat';
import { harnessChecksText } from '../../../harness/harnessChecks';
import { Markdown } from '../../markdown/Markdown';
import { openBugReport } from '../../../lib/bugReportEvent';
import { COMMUNITY_URL } from '../../../../shared/community.mjs';

export function About() {
  const codex = useHarnessStatus('codex');
  const claude = useHarnessStatus('claude');
  // the paths the user set, which read "Custom location"
  const manual = { codex: useStore((s) => s.codexBin), claude: useStore((s) => s.prefs.claudeBin) };
  return (
    <>
      <AppUpdates />
      <Group title="Community">
        <Row title="Join the community" desc="Questions, feedback and other users, on Discord.">
          <button
            className="btn-pill"
            onClick={() => native.shell.openExternal(COMMUNITY_URL).catch(toastFailure("Couldn't open the community link"))}
          >
            Join
          </button>
        </Row>
      </Group>
      <Group title="Open-source notices">
        <Row title="Third-party notices" desc="Open-source licenses.">
          <button
            className="btn-pill"
            onClick={() =>
              native.app
                .openNotices()
                .then(
                  (r) => r.ok || toastFailure("Couldn't open the notices")(r.error ?? 'the file did not open'),
                  toastFailure("Couldn't open the notices"),
                )
            }
          >
            View notices
          </button>
        </Row>
      </Group>
      <Group title="Diagnostics">
        <Row
          title="Copy diagnostics"
          desc="Version, environment, the last day's request log and the test machine's harness checks. Credentials and user name are hidden."
        >
          <button className="btn-pill" onClick={() => openBugReport(null)}>
            Report a bug
          </button>
          <button
            className="btn-pill"
            onClick={() =>
              // "copied" only once it is on the clipboard (copyText says when the write fails); the harness checks are
              // the renderer's, since the generated matrix is bundled here and not shipped to main
              native.app
                .diagnostics()
                .then(
                  (text) => copyText(`${text}\n\n${harnessChecksText(MATRIX)}\n`, 'Diagnostics copied'),
                  toastFailure("Couldn't collect diagnostics"),
                )
            }
          >
            Copy diagnostics
          </button>
        </Row>
      </Group>
      <MigrationAdvanced />
      <RequestLogAdvanced />
      <Group title="Harnesses">
        {(
          [
            ['codex', codex],
            ['claude', claude],
          ] as const
        ).map(([h, st]) => (
          <Row
            key={h}
            title={`${HARNESS_LABEL[h]} CLI`}
            desc={
              // the version and where it comes from; the full path on hover
              st.bin ? (
                <CliLine kind={h} bin={st.bin} version={st.version ?? null} installs={st.candidates} manual={manual[h]} />
              ) : (
                'Not found'
              )
            }
          >
            <button className="btn-pill" onClick={() => navigate({ name: 'settings', section: h })}>
              Manage
            </button>
          </Row>
        ))}
      </Group>
    </>
  );
}

/** A harness CLI in one line, as on its own page: "2.1.302 · Native installer", the path on hover. */
function CliLine({
  kind,
  bin,
  version,
  installs,
  manual,
}: {
  kind: string;
  bin: string;
  version: string | null;
  installs?: CliCandidate[];
  manual: string | null;
}) {
  const info = useVersionOf(kind);
  return (
    <span className="cli-line" title={bin}>
      {installLine(version, sourceOfBin(bin, { installs, manual, checked: info }))}
    </span>
  );
}

function AppUpdates() {
  const prefs = useStore((s) => s.prefs);
  const internal = !!useMoPilot().user?.internal;
  const st = useUpdateState();
  const busy = st.status === 'checking' || st.status === 'downloading' || st.status === 'installing';
  const [notesOpen, setNotesOpen] = useState(false);
  const notes = st.status === 'ready' ? (st.available?.notes.trim() ?? '') : '';
  return (
    <Group title="MoPilot">
      <Row title={`Version ${st.version || ''}`} desc={updateDescription(st)}>
        {notes && (
          <button className="btn-pill" aria-expanded={notesOpen} onClick={() => setNotesOpen((o) => !o)}>
            What's new
          </button>
        )}
        {st.status === 'ready' ? (
          <button
            className="btn primary sm"
            onClick={() => (st.manual ? native.updates.install() : native.updates.install({ when: 'now' }))}
          >
            {rollbackAction(st) ?? (st.manual ? 'Download update' : 'Restart to update')}
          </button>
        ) : (
          <button className="btn-pill" disabled={busy || st.status === 'unsupported'} onClick={() => native.updates.check()}>
            {CHECK_FOR_UPDATES}
          </button>
        )}
      </Row>
      {notes && notesOpen && (
        <div className="update-notes" aria-label="What's new">
          <Markdown text={notes} />
        </div>
      )}
      <Row
        title="Update automatically"
        desc={
          st.manual ? 'Check for new versions in the background' : 'Download new versions in the background and install them on restart'
        }
      >
        <Toggle on={prefs.autoUpdate !== false} onChange={(v) => setPrefs({ autoUpdate: v })} />
      </Row>
      <Row title="Update channel" desc="Beta gets new features first and may be less stable">
        <Select
          value={channelChoice(prefs.updateChannel, internal)}
          options={[
            { value: 'stable', label: 'Stable' },
            { value: 'beta', label: 'Beta' },
            // internal builds, offered only to staff accounts
            ...(internal ? [{ value: 'dogfood' as const, label: 'Dogfood' }] : []),
          ]}
          onChange={(v) => setPrefs({ updateChannel: v })}
        />
      </Row>
    </Group>
  );
}

/** Codex runs the picked binary only after its app server restarts; the window reloads onto it. */
async function pickCodexBin(v: string | null) {
  useStore.setState({ codexBin: v });
  await new Promise((r) => setTimeout(r, 400));
  await native.codex.restart();
  location.reload();
}

export function CodexRuntime() {
  const codexHome = useStore((s) => s.codexHome);
  return (
    <Group title="Codex CLI">
      <CodexBinaryRow />
      <Row title="Settings folder" desc={codexHome ? abbreviateHome(codexHome) : undefined}>
        <button className="btn-pill" onClick={() => codexHome && openFile(codexHome)}>
          Open
        </button>
      </Row>
      <Row title="Restart Codex" desc="Restart the background app server">
        <button
          className="btn-pill"
          onClick={() => native.codex.restart().then(() => location.reload(), toastFailure("Couldn't restart the Codex server"))}
        >
          Restart
        </button>
      </Row>
    </Group>
  );
}

function CodexBinaryRow() {
  const ua = useStore((s) => s.userAgent);
  const codexBin = useStore((s) => s.codexBin);
  const { bins, error } = useCodexBinaries();
  const current = bins?.current ?? null;
  // the version found for that binary, whole ("0.163.0-alpha.10.2"); else what the running app server says
  const version = bins?.candidates.find((c) => c.path === current)?.version ?? ua?.match(/\/([\d.]+)/)?.[1] ?? null;
  return (
    <HarnessVersionRow
      kind="codex"
      label="Codex"
      name="codex"
      bin={current}
      version={version}
      installs={bins?.candidates}
      manual={codexBin}
      where={bins}
      pending={bins ? null : error ? `Couldn't look for the Codex CLI: ${error}` : 'Detecting…'}
      onPick={(v) => void pickCodexBin(v)}
    />
  );
}
