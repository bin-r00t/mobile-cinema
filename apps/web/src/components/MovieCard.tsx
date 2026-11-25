import { Link } from "react-router-dom";

import type { MovieListItem } from "../api/movies";
import { formatDuration, formatYear } from "../lib/format";

export interface MovieCardProps {
  movie: MovieListItem;
}

/**
 * One movie of the library grid: the poster, the title and the two facts the
 * list shows — the year and the runtime.
 *
 * A movie without a poster still gets a card: the placeholder keeps the grid
 * even, and the title is always readable.
 */
export function MovieCard({ movie }: MovieCardProps) {
  const year = formatYear(movie.year);
  const duration = formatDuration(movie.durationMs);

  return (
    <article className="movie-card">
      <Link className="movie-card-link" to={`/movie/${movie.id}`}>
        <div className="movie-card-poster">
          {movie.posterUrl ? (
            <img
              className="movie-card-image"
              src={movie.posterUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={(event) => {
                // The poster file is gone: show the placeholder instead of
                // a broken image.
                event.currentTarget.style.display = "none";
              }}
            />
          ) : null}
          <div
            className="movie-card-placeholder"
            aria-hidden={movie.posterUrl ? "true" : undefined}
          >
            {movie.title.slice(0, 1).toUpperCase()}
          </div>
        </div>
        <h2 className="movie-card-title">{movie.title}</h2>
        <p className="movie-card-meta">
          {year ? <span>{year}</span> : null}
          {year && duration ? <span className="movie-card-sep">·</span> : null}
          {duration ? <span>{duration}</span> : null}
        </p>
      </Link>
    </article>
  );
}
