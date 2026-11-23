// Shared install notes, vendor documentation and manual executable selection for every install surface.
import type { ReactNode } from 'react';
import { harnessInfo } from '../../harness/registry';
import { openLink } from '../../session/open';
import type { Presence } from '../../session/harness/installable';

export function InstallGuidance({
  item,
  commands,
  onSetLocation,
  children,
}: {
  item: Presence;
  commands: boolean;
  onSetLocation: () => void;
  children?: ReactNode;
}) {
  const info = harnessInfo(item.kind);
  return (
    <>
      {info ? (
        info.dataNotes.map((note) => (
          <p className="settings-lead" key={note}>
            {note}
          </p>
        ))
      ) : (
        <p className="settings-lead">Install instructions aren't available for {item.label}. Set its location if you already have it.</p>
      )}
      {children}
      <div className="install-card-foot">
        {info && (
          <>
            <button type="button" className="text-link" onClick={() => openLink(info.install.docs)}>
              {commands ? 'Docs ↗' : `Get it from ${item.vendor} ↗`}
            </button>
            <span aria-hidden="true"> · </span>
          </>
        )}
        <button type="button" className="text-link" onClick={onSetLocation}>
          Set location…
        </button>
      </div>
    </>
  );
}
