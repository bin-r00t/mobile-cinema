import { NavLink, Outlet } from "react-router-dom";
import { InstallButton } from "./InstallButton";

export function Layout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="app-brand">
          Mobile Cinema
        </NavLink>
        <InstallButton />
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
