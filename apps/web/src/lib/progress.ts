/**
 * The last position of a movie, so that it can be picked up where it was
 * left.
 *
 * The catalog of the server has a table for it (`playback_progress`), but
 * the server does not answer it yet, so the position is kept in the
 * browser of the user until the API is there.
 */

/** Where the positions are kept. */
export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The prefix of the keys, so the positions do not mix with anything else. */
const KEY_PREFIX = "mobile-cinema:progress:";

/** A movie has to be watched a little before the position is worth keeping. */
const MIN_POSITION_MS = 10_000;

/** A movie that is nearly over is not worth resuming. */
const END_MARGIN_MS = 5_000;

/** The storage of the browser, or null when there is none. */
function browserStorage(): ProgressStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // A browser that does not allow the storage is not a reason to fail.
    return null;
  }
}

/** The key of the position of a movie. */
export function positionKey(movieId: number): string {
  return `${KEY_PREFIX}${movieId}`;
}

/**
 * The position of a movie in milliseconds, or null when there is none.
 */
export function readPosition(movieId: number, storage = browserStorage()): number | null {
  if (!storage) return null;
  const raw = storage.getItem(positionKey(movieId));
  if (raw === null) return null;
  const position = Number(raw);
  if (!Number.isFinite(position) || position < 0) return null;
  return position;
}

/**
 * Writes the position of a movie down.
 *
 * A position that is too early is not worth keeping: the movie has barely
 * started, and the user is better off at the beginning of it.
 */
export function writePosition(
  movieId: number,
  positionMs: number,
  storage = browserStorage(),
): void {
  if (!storage) return;
  if (!Number.isFinite(positionMs) || positionMs < MIN_POSITION_MS) return;
  storage.setItem(positionKey(movieId), String(Math.round(positionMs)));
}

/**
 * Forgets the position of a movie, so that it starts at the beginning the
 * next time it is opened.
 */
export function clearPosition(movieId: number, storage = browserStorage()): void {
  if (!storage) return;
  storage.removeItem(positionKey(movieId));
}

/**
 * The position a movie should be resumed at, given the position that was
 * stored for it — no matter where the position came from.
 *
 * A position that is too early is no position at all: the movie has barely
 * started. A movie that was watched to the end is not resumed: it is over.
 * Null means "start at the beginning".
 */
export function pickResumePosition(
  storedMs: number | null,
  durationMs: number,
): number | null {
  if (storedMs === null) return null;
  if (storedMs < MIN_POSITION_MS) return null;
  if (Number.isFinite(durationMs) && durationMs > 0 && storedMs > durationMs - END_MARGIN_MS) {
    return null;
  }
  return storedMs;
}

/**
 * The position the movie should be resumed at, in milliseconds.
 *
 * A movie that was watched to the end is not resumed: it is over.
 */
export function resumePosition(
  movieId: number,
  durationMs: number,
  storage = browserStorage(),
): number | null {
  return pickResumePosition(readPosition(movieId, storage), durationMs);
}
