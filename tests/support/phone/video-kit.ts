// A stand-in for the native video module and the pieces the video tests share (#5638): what it was asked, what it answers, and the events it sends.
import '../phone/register.ts';
const compressPath = '../../../mobile/src/platform/videoCompress.ts';
const { nativeVideo, videoCompressor } = await import(compressPath);

export const MB = 1024 * 1024;
export const CAP = 20 * MB;

/** A compressor of our own: what it was asked, and what it answers (a size, or a rejection with a code). */
export function fakeNative(
  answer: { size?: number; code?: string; hold?: boolean; pause?: boolean; kept?: string; failRung?: boolean; failProgress?: boolean } = {},
) {
  const asked: { uri: string; id: string; limit: number }[] = [];
  const cancelled: string[] = [];
  const listeners = new Set<(e: { id: string; progress: number; retry?: boolean }) => void>();
  const rungListeners = new Set<(e: any) => void>();
  const removed: number[] = [];
  const tracked: string[] = [];
  const untracked: string[] = [];
  let release: (v: unknown) => void = () => {};
  let finish: () => void = () => {};
  const native = {
    compress: (uri: string, id: string, limit: number) => {
      asked.push({ uri, id, limit });
      if (answer.hold)
        return new Promise((resolve, reject) => {
          release = () => reject(Object.assign(new Error('cancelled'), { code: 'ERR_VIDEO_CANCELLED' }));
        });
      if (answer.pause)
        return new Promise((resolve) => {
          finish = () =>
            resolve({
              uri: `file:///small-${id}.mp4`,
              size: answer.size ?? 5 * MB,
              ...(answer.kept ? { kept: answer.kept, estimate: 15 * MB, seconds: 7.25 } : {}),
            });
        });
      if (answer.code) return Promise.reject(Object.assign(new Error('x'), { code: answer.code }));
      return Promise.resolve({ uri: `file:///small-${id}.mp4`, size: answer.size ?? 5 * MB });
    },
    cancel: (id: string) => {
      cancelled.push(id);
      release(null);
    },
    track: (uris: string[]) => tracked.push(...uris),
    untrack: (uri: string) => untracked.push(uri),
    addListener: (event: string, listener: (e: any) => void) => {
      if (event === 'onRung' && answer.failRung) throw new Error('no such event');
      if (event === 'onProgress' && answer.failProgress) throw new Error('no such event');
      const group = event === 'onRung' ? rungListeners : listeners;
      group.add(listener);
      return { remove: () => (group.delete(listener), removed.push(1)) };
    },
  };
  nativeVideo.load = () => native;
  return {
    asked,
    cancelled,
    removed,
    tracked,
    untracked,
    finish: () => finish(),
    emit: (e: { id: string; progress: number; retry?: boolean }) => listeners.forEach((f) => f(e)),
    rung: (e: { id: string; size: string; estimate: number; bytes: number; seconds: number; outcome: string }) =>
      rungListeners.forEach((f) => f(e)),
    rungListeners,
    listeners,
  };
}
export const asset = (extra = {}) => ({
  uri: 'file:///big.mov',
  fileName: 'IMG_1.MOV',
  mimeType: 'video/quicktime',
  fileSize: 80 * MB,
  duration: 60_000,
  ...extra,
});
export const hooks = (extra = {}) => ({ compressor: videoCompressor(), id: 'v1', ...extra });
