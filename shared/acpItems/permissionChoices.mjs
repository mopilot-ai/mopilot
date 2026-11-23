// An ACP permission request's options as the approval card's buttons, in the window and in the Chrome side panel.

/**
 * The harness's options as given: the first allow is the primary button, the first reject is Deny,
 * the rest go in the dropdown. Without a reject option Deny cancels the request.
 */
export function permissionChoices(options) {
  const list = Array.isArray(options) ? options : [];
  const choice = (o) => ({
    label: o.name || o.optionId,
    result: { optionId: o.optionId },
  });
  const allow = list.find((o) => o.kind === 'allow_once') ?? list.find((o) => String(o.kind).startsWith('allow'));
  const reject = list.find((o) => o.kind === 'reject_once') ?? list.find((o) => String(o.kind).startsWith('reject'));
  const primary = allow
    ? choice(allow)
    : list[0]
      ? choice(list[0])
      : {
          label: 'OK',
          result: { optionId: null },
        };
  const more = list.filter((o) => o !== allow && o !== reject && o.optionId !== primary.result.optionId).map(choice);
  return {
    primary,
    more,
    deny: { optionId: reject?.optionId ?? null },
  };
}
