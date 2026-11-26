/**
 * The playback progress, as the server keeps it.
 *
 * The player writes the position it is at while the movie plays, the detail
 * page reads it back to offer the continue-watching prompt, and the library
 * lists the movies that were played last. The calls go to a relative "/api"
 * URL, like every other call of the app.
 */

import { readResponseError } from "./movies";

/** The stored position of one movie. */
export interface PlaybackProgress {
  movieId: number;
  positionMs: number;
  updatedAt: string;
}

/** One entry of the recently watched list: the position and its movie. */
export interface RecentlyWatched {
  movieId: number;
  positionMs: number;
  updatedAt: string;
  movie: {
    id: number;
    title: string;
    year: number | null;
    durationMs: number | null;
    posterUrl: string | null;
  };
}

/**
 * Stores the position of a movie.
 *
 * A failure is not worth raising: the playback goes on without the server,
 * and the next position of the same movie is posted a few seconds later.
 */
export async function saveProgress(movieId: number, positionMs: number): Promise<void> {
  const response = await fetch("/api/progress", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ mediaItemId: movieId, positionMs: Math.round(positionMs) }),
  });
  if (!response.ok) throw await readResponseError(response);
}

/**
 * The position of one movie, or null when it has none — a movie that was
 * never played, or one the server does not know.
 */
export async function getProgress(
  movieId: number,
  signal?: AbortSignal,
): Promise<PlaybackProgress | null> {
  const response = await fetch(`/api/progress/${movieId}`, {
    signal,
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await readResponseError(response);
  const body = (await response.json()) as { progress: PlaybackProgress };
  return body.progress;
}

/**
 * The movies that were played last, most recent first.
 */
export async function listProgress(
  limit = 8,
  signal?: AbortSignal,
): Promise<RecentlyWatched[]> {
  const response = await fetch(`/api/progress?limit=${limit}`, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw await readResponseError(response);
  const body = (await response.json()) as { items: RecentlyWatched[] };
  return body.items;
}
