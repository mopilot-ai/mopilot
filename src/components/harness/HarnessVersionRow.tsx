// A harness's one "Version" row on its Advanced settings, the same for every harness family: the version of the CLI
// chats run and how it was installed in words ("2.1.302 · Native installer"), its path only on hover, and a menu to
// pick another install found, show it in Finder, choose another path, or reset to finding it again. Its update is
// the harness page's version line (HarnessVersionLine), in the page header or under this row.
import { useState, type ReactNode } from 'react';
import { Row } from '../pages/settings/Controls';
import { BinPathInput } from '../pages/settings/Rows';
import { Menu, MenuItem, MenuLabel, MenuSeparator, useAnchor } from '../ui/Popover';
import { Ellipsis } from '../ui/icons';
import { revealPath } from '../../session/open';
import { installLine, installSource, sourceOfBin, type InstallLike, type OffPathFields } from '../../lib/cliSource';
import { useVersionOf } from '../../harness/harnessUpdates';
import { OffPathNote } from './OffPathNote';
import { revealLabel } from '../../lib/platform';
import { DIRECTORY_LABEL, DIRECTORY_PATH } from '../../lib/registryCopy';

export function HarnessVersionRow({
  kind,
  label,
  name,
  bin,
  version,
  installs = [],
  manual,
  where,
  pending,
  onPick,
  footer,
  managed = false,
}: {
  /** the registry kind: 'codex', 'claude', 'acp:<id>' */
  kind: string;
  /** the harness as people call it ("Claude Code") */
  label: string;
  /** its binary's name ("claude"), for the path field */
  name: string;
  /** the binary chats run; null when none was found */
  bin: string | null;
  version: string | null;
  /** every install found; more than one makes them a choice */
  installs?: InstallLike[];
  /** the path the user set, if any */
  manual: string | null;
  where?: OffPathFields | null;
  /** what to say while the binary isn't known yet ("Detecting…"), instead of "Not found" */
  pending?: string | null;
  /** an install picked, a path chosen, or null to find it automatically again: the harness's own handler */
  onPick: (path: string | null) => void;
  /** under the line: how it updates, where no page header says so (a basic harness's details) */
  footer?: ReactNode;
  /** A managed distribution has one app-owned path; location overrides apply only to external CLIs. */
  managed?: boolean;
}) {
  const a = useAnchor<HTMLButtonElement>();
  const [editing, setEditing] = useState(false);
  const info = useVersionOf(kind);
  // main's update check, when it read this same binary
  const checked = info && bin && info.bin === bin ? info : null;
  const source = sourceOfBin(bin, { installs, manual, checked });
  const many = installs.length > 1;
  return (
    <Row
      title="Version"
      desc={
        bin ? (
          <>
            <span className="cli-line" title={bin}>
              {managed ? `${version ?? 'Installed'} · ${DIRECTORY_LABEL}` : installLine(version, source)}
            </span>
            {!managed && <OffPathNote name={label} bin={bin} where={where} />}
            {managed ? <span className="cli-note">Updates are available in {DIRECTORY_PATH}.</span> : footer}
          </>
        ) : (
          (pending ?? 'Not found')
        )
      }
    >
      {editing ? (
        <BinPathInput name={name} value={manual} onChange={onPick} onDone={() => setEditing(false)} />
      ) : (
        <>
          <button
            ref={a.ref}
            type="button"
            className="icon-btn"
            aria-label={`${label} CLI options`}
            aria-expanded={a.open}
            onClick={a.toggle}
          >
            <Ellipsis size={15} />
          </button>
          <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end" width={260}>
            {!managed && many && (
              <>
                <MenuLabel>{installs.length} installs found</MenuLabel>
                {installs.map((i) => (
                  <MenuItem key={i.path} checked={i.path === bin} title={i.path} onSelect={() => i.path !== bin && onPick(i.path)}>
                    {installLine(i.version, installSource(i.via, i.from))}
                  </MenuItem>
                ))}
                <MenuSeparator />
              </>
            )}
            {bin && (
              <MenuItem title={bin} onSelect={() => revealPath(bin)}>
                {revealLabel()}
              </MenuItem>
            )}
            {!managed && <MenuItem onSelect={() => setEditing(true)}>Choose another…</MenuItem>}
            {!managed && manual && (
              <MenuItem title={`Stop using ${manual} and find ${label} automatically`} onSelect={() => onPick(null)}>
                Reset
              </MenuItem>
            )}
          </Menu>
        </>
      )}
    </Row>
  );
}
