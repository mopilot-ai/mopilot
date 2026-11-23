// A link to a web page that opens in the system browser: a real anchor, so Tab reaches it and Enter opens it.
import type { ReactNode } from 'react';
import { openLink } from '../../session/open';

export function WebLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        // the app window never navigates away; a link that fails to open is a toast (openLink)
        e.preventDefault();
        openLink(href);
      }}
    >
      {children}
    </a>
  );
}
