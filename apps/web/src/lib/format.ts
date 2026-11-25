/**
 * Formats the numbers of the catalog for the screen.
 */

/**
 * The runtime of a movie as "1h 42m" or "42m".
 *
 * A movie whose runtime is unknown has no duration to show, so `null` comes
 * back as `null` and the caller leaves the line out.
 */
export function formatDuration(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const totalMinutes = Math.round(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalMinutes === 0) return "<1m";
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * The year of a movie, or null when the catalog does not know one.
 */
export function formatYear(year: number | null | undefined): string | null {
  if (year === null || year === undefined) return null;
  return String(year);
}
