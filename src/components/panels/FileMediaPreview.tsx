// Audio and video use local range-capable transport and retire playback on path change or retry.
import { useEffect, useRef, useState } from 'react';
import { assetUrl } from '../../lib/paths';
import { PreviewError, PreviewLoading } from './PreviewStatus';
import type { PreviewLifecycle } from './PreviewSwap';

export function FileMediaPreview({
  path,
  kind,
  revision,
  onRetry,
  onReady,
  onFailure,
}: { path: string; kind: 'audio' | 'video'; revision?: string; onRetry: () => void } & PreviewLifecycle) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const src = assetUrl(path) + (revision ? `?preview=${encodeURIComponent(revision)}` : '');
  useEffect(() => {
    const element = media.current!;
    element.src = src;
    return () => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [src]);
  if (state === 'error')
    return <PreviewError message="Could not play this file. The file or its audio/video encoding may be unsupported." onRetry={onRetry} />;
  const props = {
    ref: media,
    src,
    controls: true,
    preload: 'auto',
    onLoadedData: () => {
      setState('ready');
      onReady();
    },
    onError: () => {
      setState('error');
      onFailure();
    },
    'aria-label': kind === 'video' ? 'Video preview' : 'Audio preview',
  };
  return (
    <div className="file-media-preview">
      {state === 'loading' && <PreviewLoading />}
      {kind === 'video' ? <video {...props} /> : <audio {...props} />}
    </div>
  );
}
