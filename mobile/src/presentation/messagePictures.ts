// Completed attachment previews share the composer's URI conversion; send readiness never drops an unfinished or failed attachment.
import type { Item } from '../remote/useAttachments';
import type { Picked } from '../remote/upload';
export const pictureSource = (file: Picked) => file.uri ?? `data:${file.mime};base64,${file.base64}`;
export const messagePictures = (items: Item[]) =>
  items.filter((item) => item.state === 'done' && item.id && item.file.mime.startsWith('image/')).map((item) => pictureSource(item.file));
export const messageReady = (text: string, items: Item[]) =>
  items.every((item) => item.state === 'done' && !!item.id) && (!!text.trim() || items.length > 0);
/** A new chat's start: on another machine only words or pictures can go, since it has none of this Mac's files. */
export const startReady = (text: string, items: Item[], remote: boolean) =>
  messageReady(text, items) && (!remote || !!text.trim() || messagePictures(items).length === items.length);
