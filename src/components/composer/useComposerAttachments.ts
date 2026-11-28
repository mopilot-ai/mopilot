// Admit local files or remote images into their originating composer, revalidating destination ownership after every asynchronous read.
import { useCallback, useRef } from 'react';
import { remoteAttachmentKind } from '../../../shared/host/attachmentKinds.mjs';
import { useAttachmentTarget } from '../../session/useAttachmentTarget';
import type { ClipboardEvent, Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { native } from '../../lib/native';
import { basename } from '../../lib/paths';
import { get as getState, setDraft, toast } from '../../store/core';
import type { Attachment } from '../../store/types';
import { noteIgnored } from '../../lib/ignored';

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;
/** A preview is cosmetic: one that can't be read leaves the attachment without it. */
const previewFailed = (error: unknown) => (noteIgnored("read an attached image's preview", error), null);

export function useComposerAttachments(o: {
  draftKey: string;
  currentDraftKey: MutableRefObject<string>;
  taRef: RefObject<unknown>;
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  attachments: Attachment[];
  threadId: string | null;
}) {
  const { draftKey, currentDraftKey, taRef, setAttachments, threadId } = o;
  const currentAttachments = useRef(o.attachments);
  currentAttachments.current = o.attachments;
  const { why, read } = useAttachmentTarget(threadId);
  const allowed = useCallback(
    (key?: string, kind: string = 'file') => {
      const now = read();
      if (key !== undefined && now.key !== key) {
        toast('The chat destination changed. Add the attachment again.');
        return false;
      }
      // Selected text needs no file lookup, even while the machine that owns this draft is being read.
      if (kind === 'selection') return true;
      if ((now.pending && kind !== 'image') || (now.blocked && !remoteAttachmentKind(kind))) {
        toast(why ?? 'Only images, files, folders and selected text can be attached to a machine chat.');
        return false;
      }
      return true;
    },
    [read, why],
  );
  const setIncoming = useCallback(
    (value: SetStateAction<Attachment[]>) => {
      const before = currentAttachments.current;
      const next = typeof value === 'function' ? value(before) : value;
      if (!next.filter((a) => !before.includes(a)).every((a) => allowed(undefined, a.kind))) return false;
      currentAttachments.current = next;
      setAttachments(next);
      return true;
    },
    [allowed, setAttachments],
  );
  const appendAttachments = (next: Attachment[], key: string) => {
    if (!next.every((a) => allowed(key, a.kind))) return;
    if (currentDraftKey.current === draftKey && taRef.current) {
      const combined = [...currentAttachments.current, ...next];
      currentAttachments.current = combined;
      setAttachments(combined);
      return;
    }
    const saved = getState().drafts[draftKey] ?? { text: '', attachments: [] };
    setDraft(draftKey, { ...saved, attachments: [...saved.attachments, ...next] });
  };

  const addFiles = async (paths: string[]) => {
    if (!paths.every((p) => allowed(undefined, IMAGE_FILE.test(p) ? 'image' : 'file'))) return;
    const key = read().key;
    const next: Attachment[] = [];
    for (const p of paths) {
      if (!allowed(key, IMAGE_FILE.test(p) ? 'image' : 'file')) return;
      const isImage = IMAGE_FILE.test(p);
      next.push({
        kind: isImage ? 'image' : 'file',
        path: p,
        name: basename(p),
        // the preview is cosmetic: an image it can't read is attached all the same
        previewUrl: isImage ? ((await native.fs.readImageDataUrl(p).catch(previewFailed)) ?? undefined) : undefined,
      });
    }
    appendAttachments(next, key);
  };

  const pickFiles = async () => {
    const key = read().key;
    const paths = await native.dialog.openFiles();
    if (allowed(key, 'image')) await addFiles(paths);
  };

  const addSketch = async (dataUrl: string) => {
    const key = read().key;
    const path = await native.fs.saveTempImage(dataUrl);
    if (!allowed(key, 'image')) return false;
    if (path) appendAttachments([{ kind: 'image', name: basename(path), path, previewUrl: dataUrl }], key);
    return true;
  };

  const onPaste = async (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    if (!files.every((f) => allowed(undefined, f.type.startsWith('image/') ? 'image' : 'file'))) return;
    const key = read().key;
    for (const f of files) {
      if (!allowed(key, f.type.startsWith('image/') ? 'image' : 'file')) return;
      const p = native.fs.pathForFile(f);
      if (p) {
        await addFiles([p]);
        if (!allowed(key, f.type.startsWith('image/') ? 'image' : 'file')) return;
      } else if (f.type.startsWith('image/')) {
        const dataUrl = await new Promise<string | null>((res) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => res(null);
          r.readAsDataURL(f);
        });
        if (!allowed(key, 'image')) return;
        if (!dataUrl) {
          toast("Couldn't read the pasted image", 'error');
          return;
        }
        const saved = await native.fs.saveTempImage(dataUrl);
        if (!allowed(key, 'image')) return;
        if (!saved) toast("Couldn't attach the pasted image", 'error');
        // a type the models can't look at (SVG, ICO) goes as a file
        else if (!IMAGE_FILE.test(saved)) await addFiles([saved]);
        else appendAttachments([{ kind: 'image', path: saved, name: 'Pasted image', previewUrl: dataUrl }], key);
      }
    }
  };
  return { addFiles, pickFiles, addSketch, onPaste, setIncoming, admit: (a: Attachment) => allowed(undefined, a.kind), attachmentOff: why };
}
