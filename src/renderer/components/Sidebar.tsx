import type { ReactNode } from 'react';

export type PageId = 'project' | 'git' | 'settings';

export function Sidebar(props: {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  footer?: ReactNode;
}) {
  const { activePage, onNavigate, footer } = props;

  return (
    <div className="sidebar">
      <div className="sidebarHeader">
        <button type="button" className="sidebarBrand" title="Inspiration" aria-label="Inspiration">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.8 13.9 10.1 21.2 12 13.9 13.9 12 21.2 10.1 13.9 2.8 12 10.1 10.1 12 2.8Z" />
            <path d="M18.2 4.4 18.95 7.05 21.6 7.8 18.95 8.55 18.2 11.2 17.45 8.55 14.8 7.8 17.45 7.05 18.2 4.4Z" />
          </svg>
        </button>
      </div>

      <div className="nav">
        <button
          className={activePage === 'project' ? 'navItem navIcon active' : 'navItem navIcon'}
          onClick={() => onNavigate('project')}
          title="Project"
          aria-label="Project"
        >
          <svg className="navGlyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.5 6.5h7v4h-7z" />
            <path d="M13.5 6.5h7v4h-7z" />
            <path d="M3.5 13.5h17v4h-17z" />
          </svg>
        </button>
        <button
          className={activePage === 'settings' ? 'navItem navIcon active' : 'navItem navIcon'}
          onClick={() => onNavigate('settings')}
          title="Settings"
          aria-label="Settings"
        >
          <svg className="navGlyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2zm0-4.4 1 .2.5 2a6.9 6.9 0 0 1 1.6.9l1.9-.8.8.8-.8 1.9c.4.5.7 1 .9 1.6l2 .5.2 1-.2 1-2 .5a6.9 6.9 0 0 1-.9 1.6l.8 1.9-.8.8-1.9-.8a6.9 6.9 0 0 1-1.6.9l-.5 2-1 .2-1-.2-.5-2a6.9 6.9 0 0 1-1.6-.9l-1.9.8-.8-.8.8-1.9a6.9 6.9 0 0 1-.9-1.6l-2-.5-.2-1 .2-1 2-.5c.2-.6.5-1.1.9-1.6l-.8-1.9.8-.8 1.9.8a6.9 6.9 0 0 1 1.6-.9l.5-2 1-.2z" />
          </svg>
        </button>
        <button
          className={activePage === 'git' ? 'navItem navIcon active' : 'navItem navIcon'}
          onClick={() => onNavigate('git')}
          title="Git"
          aria-label="Git"
        >
          <svg className="navGlyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 6.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm0 0v10a3 3 0 0 0 3 3h1.5" />
            <path d="M17 12.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm0-6a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm-7.5 12h5" />
          </svg>
        </button>
      </div>

      <div className="sidebarFooter">{footer}</div>
    </div>
  );
}
