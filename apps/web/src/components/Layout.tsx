import { NavLink, Outlet } from "react-router-dom";

export function Layout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="app-brand">
          Mobile Cinema
        </NavLink>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
