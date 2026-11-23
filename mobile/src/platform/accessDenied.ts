// The error for a camera or microphone the person has refused, so a screen can offer Open Settings (the system will not ask again).

export class AccessDenied extends Error {
  readonly what: 'camera' | 'microphone';
  constructor(what: 'camera' | 'microphone', message: string) {
    super(message);
    this.name = 'AccessDenied';
    this.what = what;
  }
}
