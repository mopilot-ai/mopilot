export interface PermissionChoice {
  label: string;
  result: {
    optionId: string | null;
  };
}
/**
 * The harness's options as given: the first allow is the primary button, the first reject is Deny,
 * the rest go in the dropdown. Without a reject option Deny cancels the request.
 */
export declare function permissionChoices(
  options: {
    optionId: string;
    name: string;
    kind: string;
  }[],
): {
  primary: PermissionChoice;
  more: PermissionChoice[];
  deny: {
    optionId: string | null;
  };
};
