// Types for shared chromeApproval approval mappings.
/**
 * Whether a harness runs Claude in Chrome in its own sessions (Claude Code does), so Claude in Chrome's live
 * link is read from that harness's chats.
 */
/** The Claude in Chrome tool a permission request names, or null. */
export declare function chromeTool(toolName: unknown): string | null;
export interface ChromeApproval {
  /** what Claude wants to do: "Click", "Type text", "Open a page" */
  action: string;
  /** the site the request names (a page to open); null when it does not say */
  host: string | null;
  /** the input, for a person: label and value */
  rows: {
    label: string;
    value: string;
  }[];
  /** code or other long text, shown as a block */
  block: string | null;
}
/** The host a URL names; null for anything that is not a web address. */
export declare function chromeHost(url: unknown): string | null;
/**
 * The request read for a person. `knownUrl` is the page an earlier step opened in the tab: the tab
 * may have moved on since, so it is shown as that, never as the site the action is on.
 */
export declare function chromeApproval(toolName: unknown, input: unknown, knownUrl?: string | null): ChromeApproval | null;
/** The page an earlier Claude in Chrome step opened in this tab (the last navigate to it), if any. */
export declare function chromeTabUrl(items: unknown[], tabId: unknown): string | null;
/**
 * The CLI's suggestions as one choice, labeled by what they keep and where; null without any.
 * The answer sends them back unchanged as updatedPermissions (claudeAnswer, acceptForSession).
 */
export declare function chromeSuggestion(suggestions: unknown): {
  label: string;
  hint: string;
} | null;
