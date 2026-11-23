import type { ThreadItem } from '../../src/protocol/v2/ThreadItem';
/** Text of one ACP content block, as markdown. */
export declare function blockText(b: unknown): string;
/** Text of a tool call's content list: its content blocks and terminal output. */
export declare function toolOutput(content: unknown): string;
/**
 * The thread item for a tool call (its merged state so far). The kind decides the card: a diff in
 * its content makes it an edit, execute a command, read and search the explored-files rows, fetch a
 * web item, everything else a generic tool card.
 */
export declare function toolItem(tc: unknown, cwd: string): ThreadItem;
