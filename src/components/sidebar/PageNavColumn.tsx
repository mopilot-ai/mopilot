// The sidebar column for a page with its own nav (Scheduled, Plugins, Code Review): a way back to the chats, the page's nav, and the account footer.
import type { ReactNode } from 'react';
import { navigate } from '../../store/panes';
import { ArrowLeft } from '../ui/icons';
import { SidebarFooter } from './SidebarFooter';

export function PageNavColumn({ children }: { children: ReactNode }) {
  return (
    <div className="page-nav-column">
      <div className="sidebar-section page-nav-back">
        <button type="button" className="side-row muted" onClick={() => navigate({ name: 'home' })}>
          <span className="side-row-icon">
            <ArrowLeft size={16} strokeWidth={1.7} />
          </span>
          <span className="side-row-label">Back to chats</span>
        </button>
      </div>
      {children}
      <SidebarFooter />
    </div>
  );
}
