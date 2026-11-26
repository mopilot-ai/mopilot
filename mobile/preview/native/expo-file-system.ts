// Test-only file boundary for the web preview: a file has no bytes, and a marker made in the cache folder is there for the rest of the preview.
const made = new Set<string>();
export const Paths = { cache: 'cache' };
export class File {
  constructor(
    readonly uri: string | object,
    readonly name?: string,
  ) {}
  get exists() {
    return made.has(`${String(this.uri)}/${this.name}`);
  }
  create() {
    made.add(`${String(this.uri)}/${this.name}`);
  }
  delete() {
    made.delete(`${String(this.uri)}/${this.name}`);
  }
  async bytes() {
    return new Uint8Array();
  }
  async base64() {
    return '';
  }
}
