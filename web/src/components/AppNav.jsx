import { APP_VERSION, NAV_PAGES, pageHash } from '../lib';

export default function AppNav({ page, setPage, collapsed, onNavigate }) {
  function go(id) {
    setPage(id);
    if (window.location.hash !== pageHash(id)) {
      window.location.hash = pageHash(id);
    }
    onNavigate?.(id);
  }

  return (
    <nav className={`app-nav ${collapsed ? 'collapsed' : ''}`}>
      <div className="nav-brand">
        <div className="logo">A</div>
        {!collapsed && (
          <div>
            <div className="nav-title">Antigravity</div>
            <div className="nav-sub">Studio v{APP_VERSION}</div>
          </div>
        )}
      </div>
      {NAV_PAGES.map((group) => (
        <div className="nav-group" key={group.group}>
          {!collapsed && <div className="nav-group-label">{group.group}</div>}
          {group.items.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => go(item.id)}
              title={item.hint}
            >
              <span className="nav-item-label">{item.label}</span>
              {!collapsed && <span className="nav-item-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
