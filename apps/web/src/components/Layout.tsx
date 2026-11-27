import { Outlet } from "react-router-dom";

import { NavBar } from "./NavBar";

export function Layout() {
  return (
    <div className="app-shell">
      <NavBar />
      {/* The target of the skip link; tabIndex lets it take the focus. */}
      <main className="app-main" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
