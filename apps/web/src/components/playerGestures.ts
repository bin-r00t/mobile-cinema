/**
 * The gestures of the player: a swipe along the screen seeks through the
 * movie, a swipe up or down turns the volume of the sound.
 */

/** How far a finger must travel before a swipe is a swipe, in pixels. */
export const SWIPE_THRESHOLD_PX = 24;

/** How many seconds a swipe across the whole width of the player seeks. */
export const SWIPE_SEEK_SPAN_SECONDS = 90;

/** What a swipe is going to do, decided once it has gone far enough. */
export type GestureIntent = "seek" | "volume";

/** Keeps a number between a floor and a ceiling. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The direction a swipe is going.
 *
 * Until the finger has gone beyond the threshold nothing is decided, and a
 * swipe that goes both ways belongs to the axis it went furthest along.
 */
export function gestureIntent(dx: number, dy: number): GestureIntent | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD_PX) return null;
  return Math.abs(dx) >= Math.abs(dy) ? "seek" : "volume";
}

/** The seconds a horizontal swipe of so many pixels seeks: right is ahead. */
export function seekSeconds(dx: number, width: number): number {
  if (width <= 0) return 0;
  return (dx / width) * SWIPE_SEEK_SPAN_SECONDS;
}

/** The volume change of a vertical swipe: up gives sound, down takes it. */
export function volumeDelta(dy: number, height: number): number {
  if (height <= 0) return 0;
  return -dy / height;
}
