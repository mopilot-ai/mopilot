// React Native WebSocket authentication uses an upgrade header, never a credential-bearing URL.
export function openPhoneSocket(url: string, token: string) {
  const NativeSocket = WebSocket as unknown as new (
    url: string,
    protocols: string[],
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new NativeSocket(url, [], { headers: { Authorization: `Bearer ${token}` } });
}
