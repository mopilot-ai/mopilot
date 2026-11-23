// Local image file previews use the asset protocol and retire each loader on a path change or retry.
import { useState } from 'react';
import { assetUrl, fileName } from '../../lib/paths';
import { ZoomableImage } from '../ui/ImageLightbox';
import { Spinner } from '../ui/icons';
import type { PreviewLifecycle } from './PreviewSwap';
export function FileImagePreview({
  path,
  revision,
  onRetry,
  onReady,
  onFailure,
}: { path: string; revision?: string; onRetry: () => void } & PreviewLifecycle) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  return (
    <div className="file-image-preview">
      {state === 'error' ? (
        <div className="empty-state" role="alert">
          <span>Could not load image. The file may be missing or damaged.</span>
          <button className="btn" type="button" aria-label="Retry image preview" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {state === 'loading' && (
            <div className="center-pad" role="status" aria-label="Loading image">
              <Spinner size={16} />
            </div>
          )}
          <ZoomableImage
            src={assetUrl(path) + (revision ? `?preview=${encodeURIComponent(revision)}` : '')}
            alt={fileName(path)}
            path={path}
            hidden={state !== 'ready'}
            onLoad={() => {
              setState('ready');
              onReady();
            }}
            onError={() => {
              setState('error');
              onFailure();
            }}
          />
        </>
      )}
    </div>
  );
}
