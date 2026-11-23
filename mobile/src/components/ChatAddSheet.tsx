// An open chat's Add to session sheet: the rows that work for this chat (its permission, where it runs, the skills its Mac lists) wired to the sheet.
import type { DraftHandle } from '../presentation/drafts';
import { useEffect, useState } from 'react';
import type { Media } from '../platform/media';
import { useMacLink } from '../macLink';
import { menusOffered } from '../remote/composerMenu';
import type { Owned } from '../remote/client';
import type { ChatControls } from '../remote/controls';
import type { useAttachments } from '../remote/useAttachments';
import { AddToSessionSheet } from './AddToSessionSheet';

export function ChatAddSheet({
  open,
  onClose,
  media,
  files,
  request,
  controls,
  openPermission,
  where,
  drafts,
}: {
  open: boolean;
  onClose: () => void;
  /** absent where the app has no media: there is then nothing to add */
  media?: Media;
  files: ReturnType<typeof useAttachments>;
  request: Owned;
  controls: ChatControls | null;
  /** opens the page the model pill opens, where the permission is set */
  openPermission: () => void;
  /** opens where the chat runs (the Mac's page); absent when there is none */
  where?: () => void;
  /** the chat's draft: the Skills row types a $ into it */
  drafts: DraftHandle;
}) {
  const mac = useMacLink();
  // whether this Mac lists skills: its Skills row types the $ that opens them
  const [skillsListed, setSkillsListed] = useState(false);
  // asked when the sheet opens, not when the chat does: the chat's first request is its follow
  useEffect(() => {
    if (!open) return;
    let live = true;
    void menusOffered(request).then((offered) => live && setSkillsListed(offered.commands));
    return () => {
      live = false;
    };
  }, [open, request]);
  // only where this Mac lets the phone set a permission
  const permission =
    controls?.methods.permit && controls.options.permissions.length
      ? { value: controls.options.permissionLabel ?? undefined, open: openPermission }
      : undefined;
  if (!media) return null;
  return (
    <AddToSessionSheet
      open={open}
      onClose={onClose}
      media={media}
      files={files}
      permission={permission}
      computer={where && { value: mac.name, open: where }}
      skills={skillsListed ? () => drafts.set(drafts.get().trim() ? `${drafts.get().trimEnd()} $` : '$') : undefined}
    />
  );
}
