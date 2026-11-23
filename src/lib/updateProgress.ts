// How far a macOS update download has got, as Settings → About and the sidebar's update row show it.
import type { UpdateState } from './native';

/** "14 MB" for a byte count: one decimal under 10 MB. */
function megabytes(bytes: number) {
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * How far the macOS download is: "14 MB of 145 MB" and its percent, or only "14 MB" when the server sent no size.
 * Null when there is no download progress to show.
 */
export function downloadProgress(st: UpdateState): { text: string; percent: number | null } | null {
  const p = st.status === 'downloading' ? st.progress : undefined;
  if (!p) return null;
  if (!p.total) return { text: megabytes(p.received), percent: null };
  const percent = Math.min(100, Math.floor((p.received / p.total) * 100));
  return { text: `${megabytes(p.received)} of ${megabytes(p.total)}`, percent };
}
