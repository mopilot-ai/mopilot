// Zoomable image thumbnails and the full-window lightbox they open.

import { useEffect, useRef, useState, type ImgHTMLAttributes, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from './icons';
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';

/**
 * A right-click on a picture whose file is known: main's menu for it, with Show in Finder (electron/app/contextMenu.cjs).
 * Without a path the press goes on, and main's own context-menu handler offers Copy Image and Save Image As….
 */
function fileImageMenu(src: string, path: string | undefined) {
  if (!path) return undefined;
  return (event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    native.menu.image({ src, path }).catch(ignoring("show a picture's menu"));
  };
}

/**
 * A thumbnail that opens a full-window preview on click, like the official app.
 * `path`: the picture's file, so its right-click menu can show it in Finder.
 */
export function ZoomableImage({
  src,
  alt,
  className,
  path,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { src: string; path?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        {...rest}
        className={`zoomable-image ${className ?? ''}`}
        src={src}
        alt={alt ?? ''}
        draggable={false}
        role="button"
        tabIndex={rest.tabIndex ?? 0}
        aria-label={rest['aria-label'] ?? (alt ? `Open image: ${alt}` : 'Open image')}
        onClick={() => setOpen(true)}
        onContextMenu={fileImageMenu(src, path)}
        onKeyDown={(event) => {
          rest.onKeyDown?.(event);
          if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      {open && <ImageLightbox src={src} alt={alt} path={path} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ImageLightbox({ src, alt, path, onClose }: { src: string; alt?: string; path?: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    closeRef.current!.focus({ preventScroll: true });
    return () => previous.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current!.focus({ preventScroll: true });
        return;
      }
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);
  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `Image preview: ${alt}` : 'Image preview'}
      // the second press of the double-click that opened it lands here too: only a fresh press closes it
      onMouseDown={(e) => e.target === e.currentTarget && e.detail <= 1 && onClose()}
    >
      <button ref={closeRef} className="lightbox-close icon-btn" onClick={onClose} aria-label="Close">
        <X size={18} />
      </button>
      <img className="lightbox-image" src={src} alt={alt ?? ''} draggable={false} onContextMenu={fileImageMenu(src, path)} />
    </div>,
    document.body,
  );
}
