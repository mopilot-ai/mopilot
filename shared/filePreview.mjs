// One file-format decision shared by the file viewer, bounded binary reads and local media transport.
import { ownTable } from './ownTable.mjs';

const MEDIA = ownTable({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
});

/** A terminal extension, independent of host OS and never taken from a folder name. */
export function previewExtension(path) {
  return /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase() ?? '';
}

export function previewMediaType(path) {
  return MEDIA[previewExtension(path)] ?? null;
}

/** @returns {'image'|'audio'|'video'|'pdf'|'html'|'canvas'|'table'|'workbook'|'word'|'slides'|'legacy'|'source'} */
export function filePreviewKind(path) {
  if (/\.canvas\.tsx$/i.test(path)) return 'canvas';
  const mime = previewMediaType(path);
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('video/')) return 'video';
  const ext = previewExtension(path);
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'csv' || ext === 'tsv') return 'table';
  if (ext === 'xlsx' || ext === 'xls') return 'workbook';
  if (ext === 'docx') return 'word';
  if (ext === 'pptx') return 'slides';
  if (ext === 'doc' || ext === 'ppt') return 'legacy';
  return 'source';
}

export function isBinaryPreviewPath(path) {
  return ['pdf', 'workbook', 'word', 'slides', 'legacy'].includes(filePreviewKind(path));
}
