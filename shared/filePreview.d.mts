// Typed contract for the shared file-format classifier and media MIME admission.
export type FilePreviewKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'html'
  | 'canvas'
  | 'table'
  | 'workbook'
  | 'word'
  | 'slides'
  | 'legacy'
  | 'source';
export function previewExtension(path: string): string;
export function previewMediaType(path: string): string | null;
export function filePreviewKind(path: string): FilePreviewKind;
export function isBinaryPreviewPath(path: string): boolean;
