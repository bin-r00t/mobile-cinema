import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { InstallButton } from "./InstallButton";

/*
 * The chrome above every page: the skip link, the brand, the links of the
 * navigation and the install button. From 64rem up the links stand in a
 * row on the right of the header (desktop.css); below it they sit next to
 * the brand, where the header has always had its room.
 *
 * On a movie page the navigation also names the movie that is open, so the
 * trail brand, library, movie is visible and the way back stands in the
 * header on every page. The title is fetched here, in the chrome, so the
 * pages keep the way they fetch their data.
 */
export function NavBar() {
  const location = useLocation();
  const movieId = /^\/movie\/(\d+)$/.exec(location.pathname)?.[1] ?? null;
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    if (movieId === null) {
      setTitle(null);
      return;
    }

    let cancelled = false;
    setTitle(null);
    fetch(`/api/movies/${movieId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("the movie did not load");
        return (await response.json()) as { movie: { title: string } };
      })
      .then((body) => {
        if (!cancelled) setTitle(body.movie?.title ?? null);
      })
      .catch(() => {
        // The crumb stays away; the library link remains the way back.
        if (!cancelled) setTitle(null);
      });

    return () => {
      cancelled = true;
    };
  }, [movieId]);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to the content
      </a>
      <header className="app-header">
        <Link to="/" className="app-brand">
          Mobile Cinema
        </Link>
        <nav className="app-nav" aria-label="Main">
          <NavLink to="/" end className="app-nav-link">
            Library
          </NavLink>
          {movieId !== null && title !== null ? (
            <NavLink to={`/movie/${movieId}`} className="app-nav-link">
              {title}
            </NavLink>
          ) : null}
        </nav>
        <InstallButton />
      </header>
    </>
  );
}
