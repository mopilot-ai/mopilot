// Test-only sign-in boundary for the web preview: the injected runtime is already signed in.
export class AuthRequest {
  async promptAsync() {
    return { type: 'dismiss' };
  }
}
