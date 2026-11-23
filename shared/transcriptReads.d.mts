// Types for latest-read ownership shared by external transcript followers.
export class TranscriptReads {
  begin(id: string, valid: () => boolean): () => boolean;
  forget(id: string): void;
}
