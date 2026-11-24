// Types preserved by the own-key lookup-table constructor.
export function ownTable<T extends Readonly<Record<string, unknown>>>(values: T): T;
export function ownGet<T>(table: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined;
