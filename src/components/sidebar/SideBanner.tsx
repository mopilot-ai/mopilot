// The card above the sidebar's chat list: an icon, a title with an optional line under it, and its actions on their own row at the trailing edge.

import type { ReactNode } from 'react';
import styles from '../sideBanner.module.css';

/**
 * `tone` "ask" is a question for the user (neutral card, accent icon); "warn" is something that went wrong
 * (the warning tint). The icon sits beside the title's first line however the title wraps.
 */
export function SideBanner({
  tone,
  icon,
  title,
  detail,
  testId,
  children,
}: {
  tone: 'ask' | 'warn';
  icon: ReactNode;
  title: string;
  detail?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.slot}>
      <div className={styles.banner} data-tone={tone} role="alert" data-testid={testId}>
        <span className={styles.icon}>{icon}</span>
        <div className={styles.text}>
          <div className={styles.title}>{title}</div>
          {detail ? <div className={styles.detail}>{detail}</div> : null}
        </div>
        <div className={styles.actions}>{children}</div>
      </div>
    </div>
  );
}
