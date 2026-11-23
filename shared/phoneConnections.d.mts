// Types for phone connection labels and counts shared by the tray and Settings.
export type PhoneConnection = 'connected' | 'offline' | 'unknown' | 'paused' | 'closed' | 'removed' | 'locked';
export const PHONE_CONNECTION_LABEL: Readonly<Record<PhoneConnection, string>>;
export function phoneCounts(devices: { connection: PhoneConnection; retired: boolean }[]): { paired: number; connected: number };
export function phoneSummary(devices: { connection: PhoneConnection; retired: boolean }[]): string;
