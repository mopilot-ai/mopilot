// Pictures of the image files a message is sending, so its bubble shows them at once rather than reading each file again.
import type { Attachment } from '../../shared/model/store';

const known = new Map<string, string>();
const KNOWN_MAX = 32;

/** Keep the previews of a message's images (the composer has them as data URLs) for the bubble that shows it. */
export function rememberSentImages(attachments: Attachment[]) {
  for (const a of attachments) {
    if (a.kind !== 'image' || !a.previewUrl) continue;
    known.delete(a.path);
    known.set(a.path, a.previewUrl);
  }
  // the oldest go: only the messages being sent now need theirs
  while (known.size > KNOWN_MAX) known.delete(known.keys().next().value!);
}

/** The picture of an image file a message sent, if this window still has it. */
export function sentImage(path: string): string | undefined {
  return known.get(path);
}
