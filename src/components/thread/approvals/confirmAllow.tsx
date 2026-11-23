// The allow button of a confirmation card (computerConfirm): for this task, this errand, for good on a high-risk site, or once held.
import { MenuItem } from '../../ui/Popover';
import type { SageApprovalAnswer } from '../../../lib/native';
import { AllowSplit } from './shared';

/**
 * Which allow a confirmation offers first: an ordinary action on a high-risk site "for this task" (#2328), an ordinary message
 * "for this errand", a high-risk site's ordinary actions "always" (#5464, a click: no hold), else Allow once held (⌘↩ for a
 * second). The other scopes the card offers sit in the button's menu.
 */
export function ConfirmAllow({
  task,
  errand,
  siteAlways,
  holding,
  answer,
}: {
  task: boolean;
  errand: boolean;
  siteAlways: boolean;
  holding: boolean;
  answer: (r: SageApprovalAnswer) => void;
}) {
  const once = () => answer({ decision: 'allow', scope: 'once' });
  const always = () => answer({ decision: 'allow', scope: 'always' });
  if (task)
    return (
      <AllowSplit
        human
        label="Allow for this task"
        title="Ordinary actions this turn. Submissions still ask."
        kbd="2"
        onAllow={() => answer({ decision: 'allow', scope: 'task' })}
        menu={
          <>
            <MenuItem onSelect={once} right={<kbd>⌘⏎</kbd>}>
              Allow once
            </MenuItem>
            {siteAlways && (
              <MenuItem onSelect={always} right={<kbd>⇧⌘⏎</kbd>}>
                Always allow on this site
              </MenuItem>
            )}
          </>
        }
      />
    );
  if (errand)
    return (
      <AllowSplit
        human
        label="Allow messages for this errand"
        title="Offers, order changes and personal details still ask."
        kbd="2"
        onAllow={() => answer({ decision: 'allow', scope: 'errand' })}
        menu={
          <MenuItem onSelect={once} right={<kbd>⌘⏎</kbd>}>
            Allow once
          </MenuItem>
        }
      />
    );
  if (siteAlways)
    return (
      <AllowSplit
        human
        label="Always allow on this site"
        title="Includes page JavaScript. Remove in Settings → Browser."
        kbd="⇧⌘⏎"
        onAllow={always}
        menu={
          <MenuItem onSelect={once} right={<kbd>{holding ? 'holding…' : 'hold ⌘⏎'}</kbd>}>
            Allow once
          </MenuItem>
        }
      />
    );
  return <AllowSplit human holding={holding} label="Allow once" kbd="hold ⌘⏎" onAllow={once} />;
}
