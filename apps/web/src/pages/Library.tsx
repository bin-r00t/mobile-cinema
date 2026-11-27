import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link } from "react-router-dom";

import {
  listMovies,
  type MovieListItem,
  type SortKey,
  type SortOrder,
} from "../api/movies";
import { listProgress, type RecentlyWatched } from "../api/progress";
import { MovieCard } from "../components/MovieCard";
import "../styles/library.css";

/** How many movies one page of the grid holds. */
const PAGE_SIZE = 24;

/** How long the search waits for the keyboard before it asks the server. */
const SEARCH_DEBOUNCE_MS = 300;

/** One entry of the sort dropdown. */
interface SortOption {
  value: string;
  label: string;
  sort: SortKey;
  order: SortOrder;
}

/** The sort the library starts with. */
const DEFAULT_SORT: SortOption = {
  value: "title-asc",
  label: "Title (A–Z)",
  sort: "title",
  order: "asc",
};

/** The sorts the dropdown offers. */
const SORT_OPTIONS: ReadonlyArray<SortOption> = [
  DEFAULT_SORT,
  { value: "title-desc", label: "Title (Z–A)", sort: "title", order: "desc" },
  { value: "year-desc", label: "Newest movies", sort: "year", order: "desc" },
  { value: "year-asc", label: "Oldest movies", sort: "year", order: "asc" },
  { value: "added-desc", label: "Recently added", sort: "added", order: "desc" },
  { value: "added-asc", label: "Oldest added", sort: "added", order: "asc" },
];

/** What the page shows while it waits for the server. */
type Status = "loading" | "ready" | "error";

/**
 * The library: every movie of the catalog as a grid of posters, with a search
 * box and a sort dropdown on top.
 *
 * The list comes from the server — it searches and sorts there — so every
 * change of the search or the sort is a new request. The requests are
 * debounced and aborted: a request that is still on its way when the search
 * changes again is dropped, so a slow answer cannot overwrite a newer one.
 */
export function Library() {
  const [query, setQuery] = useState("");
  const [sortValue, setSortValue] = useState(DEFAULT_SORT.value);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [movies, setMovies] = useState<MovieListItem[]>([]);
  const [total, setTotal] = useState(0);
  /** The movies that were played last, for the row above the grid. */
  const [recent, setRecent] = useState<RecentlyWatched[]>([]);

  // The recently watched row is asked for once, when the page opens: it
  // belongs to the library as a whole, not to the search or the sort. A
  // server that does not answer takes the row away, not the page.
  useEffect(() => {
    const controller = new AbortController();
    listProgress(8, controller.signal)
      .then((items) => setRecent(items))
      .catch(() => setRecent([]));
    return () => controller.abort();
  }, []);

  // The number that tells the effect when to ask the server again.
  const requestId = useRef(0);

  const sort = useMemo(() => {
    const option = SORT_OPTIONS.find((candidate) => candidate.value === sortValue);
    return option ?? DEFAULT_SORT;
  }, [sortValue]);

  const load = useCallback(
    async (
      search: string,
      options: { sort: SortKey; order: SortOrder },
      signal: AbortSignal,
    ) => {
      const id = ++requestId.current;
      try {
        const result = await listMovies({
          q: search,
          sort: options.sort,
          order: options.order,
          limit: PAGE_SIZE,
          signal,
        });
        // A newer request has been started in the meantime: this answer is
        // outdated and must not touch the screen.
        if (id !== requestId.current) return;
        setMovies(result.items);
        setTotal(result.total);
        setError(null);
        setStatus("ready");
      } catch (err) {
        if (
          signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError")
        )
          return;
        if (id !== requestId.current) return;
        setError(
          err instanceof Error ? err.message : "The library could not be loaded",
        );
        setStatus("error");
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void load(query, { sort: sort.sort, order: sort.order }, controller.signal);
      },
      query ? SEARCH_DEBOUNCE_MS : 0,
    );

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, sort, load]);

  const searching = query.trim().length > 0;

  /** The cards of the grid, in the order the grid lays them out. */
  const gridRef = useRef<HTMLDivElement | null>(null);

  /*
   * The arrow keys walk the grid: from a card to its neighbour, in the
   * direction of the key. The columns come from the laid-out grid, so the
   * walk follows the columns the screen really shows — on a phone as well
   * as on a desktop.
   */
  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = Array.from(
      grid.querySelectorAll<HTMLAnchorElement>(".movie-card-link"),
    );
    const index = cards.indexOf(
      document.activeElement as HTMLAnchorElement,
    );
    if (index === -1) return;

    const columns = getComputedStyle(grid)
      .gridTemplateColumns.split(" ")
      .filter((width) => width.length > 0).length;
    if (columns === 0) return;

    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = index + 1;
        break;
      case "ArrowLeft":
        next = index - 1;
        break;
      case "ArrowDown":
        next = index + columns;
        break;
      case "ArrowUp":
        next = index - columns;
        break;
      default:
        return;
    }
    const target = cards[next];
    if (next < 0 || next >= cards.length || target === undefined) return;

    event.preventDefault();
    target.focus();
  };

  return (
    <section className="page page-library">
      <div className="library-toolbar">
        <div className="library-search">
          <label className="visually-hidden" htmlFor="library-search-input">
            Search movies by title
          </label>
          <input
            id="library-search-input"
            className="library-search-input"
            type="search"
            value={query}
            placeholder="Search by title…"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="library-sort">
          <label className="visually-hidden" htmlFor="library-sort-select">
            Sort movies
          </label>
          <select
            id="library-sort-select"
            className="library-sort-select"
            value={sortValue}
            onChange={(event) => setSortValue(event.target.value)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {status === "ready" && movies.length > 0 ? (
          <p className="library-count muted">
            {total} {total === 1 ? "movie" : "movies"}
            {searching ? ` matching “${query.trim()}”` : ""}
          </p>
        ) : null}
      </div>

      {status === "loading" ? <LibrarySkeleton /> : null}

      {status === "error" ? (
        <div className="library-state library-state-error" role="alert">
          <p className="library-state-title">The library could not be loaded</p>
          <p className="muted">{error}</p>
          <button
            className="library-button"
            type="button"
            onClick={() => {
              const controller = new AbortController();
              void load(
                query,
                { sort: sort.sort, order: sort.order },
                controller.signal,
              );
            }}
          >
            Try again
          </button>
        </div>
      ) : null}

      {status === "ready" && movies.length === 0 ? (
        <div className="library-state">
          <p className="library-state-title">
            {searching ? `Nothing matches “${query.trim()}”` : "The library is empty"}
          </p>
          <p className="muted">
            {searching
              ? "Try another title."
              : "Scan a movie folder on the server to fill the library."}
          </p>
        </div>
      ) : null}

      {status === "ready" && !searching && recent.length > 0 ? (
        <section className="recent-row" aria-label="Recently watched">
          <h2 className="recent-row-title">Recently watched</h2>
          <ul className="recent-row-list">
            {recent.map((entry) => {
              const fraction =
                entry.movie.durationMs !== null && entry.movie.durationMs > 0
                  ? Math.min(1, entry.positionMs / entry.movie.durationMs)
                  : 0;
              return (
                <li key={entry.movieId} className="recent-row-item">
                  <Link className="recent-card" to={`/movie/${entry.movieId}`}>
                    <span className="recent-card-poster">
                      {entry.movie.posterUrl ? (
                        <img src={entry.movie.posterUrl} alt="" loading="lazy" />
                      ) : null}
                      <span
                        className="recent-card-progress"
                        style={{ width: `${Math.round(fraction * 100)}%` }}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="recent-card-title">{entry.movie.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {status === "ready" && movies.length > 0 ? (
        <div className="library-grid" ref={gridRef} onKeyDown={onGridKeyDown}>
          {movies.map((movie) => (
            <MovieCard key={movie.id} movie={movie} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The placeholders that stand in for the grid while it loads. */
function LibrarySkeleton() {
  return (
    <div className="library-grid" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div className="movie-card movie-card-skeleton" key={index}>
          <div className="movie-card-poster skeleton-block" />
          <div className="skeleton-line skeleton-line-wide" />
          <div className="skeleton-line skeleton-line-narrow" />
        </div>
      ))}
    </div>
  );
}
