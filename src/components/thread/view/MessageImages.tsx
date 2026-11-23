// A user message's images, drawn the same while the message is still being sent and once it is in the chat.
import { useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import { ignoring } from '../../../lib/ignored';
import { fingerprint, withKeys } from '../../../lib/listKeys';
import { ZoomableImage } from '../../ui/ImageLightbox';
import { sentImage } from '../../../lib/sentImages';
import { isHostPicture, useHostPicture } from '../../../lib/hostPicture';

export interface MessageImage {
  /** the picture itself (a data URL), when the message carries it */
  src?: string;
  /** the image file, read when there is no `src` */
  path?: string;
}

/**
 * The pictures above a user bubble, as Claude Desktop lays them out: one shown large, several side by side and smaller.
 * `pending`: the message is still being sent, so they pulse and don't open yet.
 */
export function MessageImages({ images, pending = false, chatId = '' }: { images: MessageImage[]; pending?: boolean; chatId?: string }) {
  if (images.length === 0) return null;
  const cls = ['user-images', images.length > 1 && 'several', pending && 'pending'].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      {withKeys(images, (im) => fingerprint(`${im.path}\n${im.src}`)).map(({ key, item: im }) => (
        <UserImage key={key} src={im.src} path={im.path} pending={pending} chatId={chatId} />
      ))}
    </div>
  );
}

function UserImage({ src, path, pending, chatId }: MessageImage & { pending: boolean; chatId: string }) {
  if (!isHostPicture(src)) return <FileImage src={src} path={path} pending={pending} />;
  return path ? <SentImage chatId={chatId} src={src} path={path} pending={pending} /> : <MachineImage chatId={chatId} src={src} />;
}

/** A picture this Mac just sent to a machine: drawn from the file it attached while that is still there, and from the machine once it is not (the composer's files are temporary; the machine's copy is what lasts). */
function SentImage({ chatId, src, path, pending }: { chatId: string; src: string; path: string; pending: boolean }) {
  const [url, setUrl] = useState<string | null | undefined>(sentImage(path));
  useEffect(() => {
    if (url === undefined) native.fs.readImageDataUrl(path).then(setUrl, (e) => (ignoring("read a sent picture's file")(e), setUrl(null)));
  }, [url, path]);
  if (url === undefined) return <span className="user-image user-image-loading" role="img" aria-label="Loading picture" />;
  if (url === null) return <MachineImage chatId={chatId} src={src} />;
  return pending ? (
    <img className="user-image" src={url} alt="" draggable={false} />
  ) : (
    <ZoomableImage className="user-image" src={url} path={path} />
  );
}

/** A picture a machine holds (a message read back from history): fetched from it, with a placeholder meanwhile and a short line, with the way out, when it cannot be had. */
function MachineImage({ chatId, src }: { chatId: string; src: string }) {
  const picture = useHostPicture(chatId, src);
  if (picture.state === 'ready') return <ZoomableImage className="user-image" src={picture.url} />;
  if (picture.state === 'loading') return <span className="user-image user-image-loading" role="img" aria-label="Loading picture" />;
  if (picture.state === 'retry' || picture.state === 'offline')
    return (
      <span className="user-image-missing">
        {picture.state === 'retry' ? "Couldn't load the picture" : `Picture is on ${picture.machine}, offline`}{' '}
        <button type="button" className="user-image-retry" disabled={picture.asking} onClick={picture.retry}>
          {picture.asking ? 'Trying…' : 'Try again'}
        </button>
      </span>
    );
  const machine = picture.machine ?? 'the machine';
  const words = {
    blocked: `Pair with ${machine} again to see this picture`,
    update: `Update ${machine} to see this picture`,
    gone: `Picture is no longer on ${machine}`,
  };
  return <span className="user-image-missing">{words[picture.state]}</span>;
}

function FileImage({ src, path, pending }: MessageImage & { pending: boolean }) {
  const [url, setUrl] = useState(src ?? (path ? sentImage(path) : undefined) ?? null);
  useEffect(() => {
    // unreadable: the message shows without the picture
    if (!url && path) native.fs.readImageDataUrl(path).then(setUrl, ignoring("read a sent image's picture"));
  }, [url, path]);
  if (!url) return null;
  return pending ? (
    <img className="user-image" src={url} alt="" draggable={false} />
  ) : (
    <ZoomableImage className="user-image" src={url} path={path} />
  );
}
