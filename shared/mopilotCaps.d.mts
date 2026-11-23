export type GatewayEntry = { wires?: string[]; fast?: boolean; service_tiers?: string[]; web_search?: boolean; drops?: string[] };
export type GatewayTable = Record<string, GatewayEntry>;
export function gatewayEntry(table: GatewayTable | null | undefined, id: string | null | undefined): GatewayEntry | null;
export function gatewayId(table: GatewayTable | null | undefined, id: string | null | undefined): string | null;
export function claudeModelServed(table: GatewayTable | null | undefined, id: string): boolean;
export function gatewayDrops(table: GatewayTable | null | undefined, id: string | null | undefined, harness: string): string[];
