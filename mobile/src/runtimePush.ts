// The registrations a signed-in phone makes with the relay on its one authenticated socket (its alert token and its Live Activity token), connecting the socket first when it is down.
export interface RelayTokens {
  connected(): boolean;
  registerPush(platform: 'apns' | 'fcm', token: string): Promise<unknown>;
  unregisterPush(): Promise<unknown>;
  registerActivity(token: string): Promise<unknown>;
  unregisterActivity(): Promise<unknown>;
}

export function relayTokenMethods(relay: RelayTokens, ensure: () => Promise<unknown>) {
  const connected = async () => {
    if (!relay.connected()) await ensure();
  };
  return {
    async pushRegister(platform: 'apns' | 'fcm', token: string) {
      await connected();
      await relay.registerPush(platform, token);
    },
    async pushUnregister() {
      await connected();
      await relay.unregisterPush();
    },
    async activityRegister(token: string) {
      await connected();
      await relay.registerActivity(token);
    },
    async activityUnregister() {
      await connected();
      await relay.unregisterActivity();
    },
  };
}
