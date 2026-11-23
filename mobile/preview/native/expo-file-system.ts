// Test-only file boundary for the web preview: a file has no bytes.
export class File {
  constructor(readonly uri: string) {}
  async bytes() {
    return new Uint8Array();
  }
  async base64() {
    return '';
  }
}
